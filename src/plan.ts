/**
 * Stage [2] plan — resolve the App Intent into a concrete Azure resource graph.
 *
 * This is the core deliverable. It takes the capability-shaped {@link AppIntent}
 * and, applying guardrails (policy wins) and budget posture, resolves:
 *   • the region (guardrail-pinned, else one documented MVP default),
 *   • the SKU tier (economy for sponsorship/free-trial/economy guardrail),
 *   • the resource graph (via the capability→Azure map),
 *   • a plain-English summary, confirm cards, guardrail notes and a budget roll-up.
 * Pure and deterministic. No Azure calls — this only computes a preview.
 */

import {
  buildBackgroundJobs,
  buildChatModel,
  buildManagedEnvironment,
  buildObjectStorage,
  buildRelational,
  buildSearch,
  buildWebCompute,
  type MapContext,
} from "./azure-map.js";
import { describeBudget, prefersEconomy } from "./budget-core.js";
import type {
  AppIntent,
  AzurePlan,
  AzureResource,
  BudgetContext,
  CapabilityName,
  ClockOptions,
  Confirmation,
  Guardrails,
  Need,
  PlanBudget,
} from "./types.js";

/** One documented MVP default region when no guardrail pins one. */
export const DEFAULT_REGION = "eastus2";

/** True when the plan provisions a PostgreSQL flexible server (needs a password). */
export function planNeedsPgPassword(plan: AzurePlan): boolean {
  return plan.resources.some((r) => r.type === "Microsoft.DBforPostgreSQL/flexibleServers");
}

export interface PlanOptions extends ClockOptions {
  guardrails?: Guardrails;
  budget?: BudgetContext;
}

export function plan(intent: AppIntent, opts: PlanOptions = {}): AzurePlan {
  const now = opts.now ?? (() => new Date());
  const guardrails = opts.guardrails ?? intent.guardrails;
  const budget = opts.budget ?? intent.budget;

  const { region, pinnedByGuardrail } = resolveRegion(guardrails);
  const economy = resolveEconomy(guardrails, budget);

  const needs = intent.needs;
  const hasCompute = needs.some((n) => n.capability === "web-compute" || n.capability === "background-jobs");
  const ctx: MapContext = { region, economy, ...(hasCompute ? { envId: "app-env" } : {}) };

  const resources = buildResources(needs, ctx, guardrails);
  materializeNames(resources, intent.app.name);
  wireComputeDependencies(resources);

  const guardrailNotes = buildGuardrailNotes(guardrails, needs, region, pinnedByGuardrail);
  const planBudget = rollUpBudget(resources, guardrails, budget);
  const confirmations = buildPlanConfirmations(intent, needs, region, pinnedByGuardrail, guardrails);
  const warnings = buildWarnings(needs, guardrails);
  const summary = buildSummary(intent, resources, region, planBudget, budget);

  return {
    region,
    resources,
    summary,
    confirmations,
    guardrailNotes,
    warnings,
    budget: planBudget,
    meta: { generatedBy: "azx", generatedAt: now().toISOString(), dryRun: true },
  };
}

// ---------------------------------------------------------------------------
// Region & SKU resolution (guardrails win)
// ---------------------------------------------------------------------------

/**
 * Azure regions are lowercase alphanumerics (e.g. eastus, westeurope). Strip
 * everything else so a stray quote/whitespace/newline in a resolved region can
 * never corrupt the generated Bicep preview.
 */
export function slugifyRegion(region: string): string {
  return region.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolveRegion(guardrails?: Guardrails): { region: string; pinnedByGuardrail: boolean } {
  const first = guardrails?.regions?.[0];
  if (first) {
    const slug = slugifyRegion(first);
    if (slug) return { region: slug, pinnedByGuardrail: true };
  }
  return { region: DEFAULT_REGION, pinnedByGuardrail: false };
}

function resolveEconomy(guardrails?: Guardrails, budget?: BudgetContext): boolean {
  if (guardrails?.skuTier === "economy") return true;
  if (guardrails?.skuTier === "standard") return false;
  return prefersEconomy(budget);
}

// ---------------------------------------------------------------------------
// Resource graph
// ---------------------------------------------------------------------------

function buildResources(needs: Need[], ctx: MapContext, guardrails?: Guardrails): AzureResource[] {
  const resources: AzureResource[] = [];
  if (ctx.envId) resources.push(buildManagedEnvironment(ctx));

  let searchAdded = false;
  for (const need of needs) {
    switch (need.capability) {
      case "web-compute":
        resources.push(...buildWebCompute(need, ctx));
        break;
      case "transactional-relational":
        resources.push(...buildRelational(need, ctx));
        break;
      case "chat-model":
        if (isAzureOpenAIProvider(need) && selectedModels(need, guardrails).length > 0) {
          resources.push(...buildChatModel(need, ctx, guardrails?.approvedModels));
        }
        break;
      case "embeddings":
        // Served by pgvector? Then no Azure resource — Postgres handles it.
        if (need.options?.servedBy === "pgvector") break;
        if (!searchAdded) {
          resources.push(...buildSearch("embeddings", ctx));
          searchAdded = true;
        }
        break;
      case "search-index":
        if (!searchAdded) {
          resources.push(...buildSearch("search-index", ctx));
          searchAdded = true;
        }
        break;
      case "object-storage":
        resources.push(...buildObjectStorage(need, ctx));
        break;
      case "background-jobs":
        resources.push(...buildBackgroundJobs(need, ctx));
        break;
      default:
        // Unknown capability — never guessed. buildPlanConfirmations surfaces it
        // as an "unresolved capability" confirm card (see RESOLVABLE_CAPABILITIES).
        break;
    }
  }
  return resources;
}

/** The web app / jobs should deploy after the data resources they use. */
function wireComputeDependencies(resources: AzureResource[]): void {
  const ids = new Set(resources.map((r) => r.id));
  const dataIds = ["postgres", "openai", "search", "storage"].filter((id) => ids.has(id));
  for (const r of resources) {
    if (r.id !== "web" && r.id !== "jobs") continue;
    const deps = new Set(r.dependsOn ?? []);
    for (const d of dataIds) deps.add(d);
    r.dependsOn = [...deps].sort((a, b) => a.localeCompare(b));
  }
}

/** Replace the `${appName}` token in resource names (storage has stricter rules). */
function materializeNames(resources: AzureResource[], appName: string): void {
  const slug = appName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
  const hash = stableHash(appName);
  for (const r of resources) {
    if (!r.name.includes("${appName}")) continue;
    const candidate = r.name.replace(/\$\{appName\}/g, slug);
    switch (r.type) {
      case "Microsoft.Storage/storageAccounts":
        r.name = withGlobalSuffix(("st" + slug).replace(/[^a-z0-9]/g, ""), hash, 24, "");
        break;
      case "Microsoft.CognitiveServices/accounts":
        r.name = withGlobalSuffix(candidate, hash, 64, "-");
        break;
      case "Microsoft.Search/searchServices":
        r.name = withGlobalSuffix(candidate, hash, 60, "-");
        break;
      case "Microsoft.DBforPostgreSQL/flexibleServers":
        r.name = withGlobalSuffix(candidate, hash, 63, "-");
        break;
      case "Microsoft.App/containerApps":
      case "Microsoft.App/jobs":
        r.name = clampName(candidate, 32);
        break;
      case "Microsoft.App/managedEnvironments":
        r.name = clampName(candidate, 60);
        break;
      default:
        r.name = candidate;
    }
  }
}

function withGlobalSuffix(name: string, hash: string, limit: number, separator: string): string {
  const suffix = separator + hash;
  const head = name.slice(0, limit - suffix.length).replace(/-+$/g, "") || "app";
  return (head + suffix).slice(0, limit).replace(/-+$/g, "");
}

/** Deterministically shorten a name to `limit` chars, appending a stable hash suffix. */
function clampName(name: string, limit: number): string {
  if (name.length <= limit) return name;
  const suffix = fnv1a(name).toString(36).slice(0, 6);
  const keep = Math.max(1, limit - 1 - suffix.length);
  const head = name.slice(0, keep).replace(/-+$/g, "") || name.slice(0, 1);
  return `${head}-${suffix}`;
}

/** FNV-1a 32-bit hash (dependency-free, deterministic). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }

  return h >>> 0;
}

/** Deterministic 64-bit FNV-1a suffix: materially safer than a short app-name truncation. */
function stableHash(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(s)) {
    h ^= BigInt(byte);
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(36).padStart(13, "0").slice(-10);
}

// ---------------------------------------------------------------------------
// Guardrail notes
// ---------------------------------------------------------------------------

function buildGuardrailNotes(
  guardrails: Guardrails | undefined,
  needs: Need[],
  region: string,
  pinned: boolean,
): string[] {
  const notes: string[] = [];
  if (!guardrails) return notes;

  if (pinned && guardrails.regions?.length) {
    notes.push(`Region pinned to ${region} by guardrails (allowed: ${guardrails.regions.join(", ")}).`);
  }

  if (guardrails.approvedModels?.length) {
    notes.push(`Model allow-list enforced: ${guardrails.approvedModels.join(", ")}.`);
    const dropped = droppedModels(needs, guardrails.approvedModels);
    if (dropped.length) {
      notes.push(`Dropped models not on the approved list: ${dropped.join(", ")}.`);
    }
  }

  if (guardrails.skuTier) notes.push(`SKU tier forced to '${guardrails.skuTier}' by guardrails.`);
  if (guardrails.budget?.monthlyCapUsd !== undefined) {
    notes.push(
      `Monthly spend cap: $${guardrails.budget.monthlyCapUsd} (onExceed: ${guardrails.budget.onExceed ?? "warn"}).`,
    );
  }
  if (guardrails.notes?.length) notes.push(...guardrails.notes);
  return notes;
}

function droppedModels(needs: Need[], approved: string[]): string[] {
  const allow = new Set(approved.map((m) => m.toLowerCase()));
  const dropped = new Set<string>();
  for (const need of needs) {
    const models = Array.isArray(need.options?.models) ? (need.options!.models as string[]) : [];
    for (const m of models) if (!allow.has(m.toLowerCase())) dropped.add(m);
  }
  return [...dropped].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Budget roll-up
// ---------------------------------------------------------------------------

function rollUpBudget(
  resources: AzureResource[],
  guardrails: Guardrails | undefined,
  budget: BudgetContext | undefined,
): PlanBudget {
  const estimatedMonthlyUsd = resources.reduce((sum, r) => sum + (r.estimatedMonthlyUsd ?? 0), 0);
  const currency = budget?.currency ?? "USD";
  const cap = guardrails?.budget?.monthlyCapUsd;
  const onExceed = guardrails?.budget?.onExceed ?? "warn";
  const warnings: string[] = [];
  let blocked = false;
  const unbounded = resources.some((r) =>
    r.type === "Microsoft.CognitiveServices/accounts" ||
    r.type === "Microsoft.CognitiveServices/accounts/deployments" ||
    r.type === "Microsoft.App/containerApps" ||
    r.type === "Microsoft.App/jobs",
  );

  warnings.push("Cost estimates are advisory; consumption and usage charges are not a hard spend limit.");
  if (unbounded) warnings.push("The plan contains usage-based services whose maximum monthly cost is unknown.");
  if (cap !== undefined && onExceed === "block" && unbounded) {
    blocked = true;
    warnings.push(
      `Blocked by guardrail: azx cannot prove the $${cap}/mo cap while usage-based consumption is unbounded.`,
    );
  }

  if (prefersEconomy(budget)) {
    warnings.push(
      `${budget?.classification ?? "credit-limited"} subscription: using economy SKUs; monitor burn against your credit.`,
    );
  }
  if (cap !== undefined && estimatedMonthlyUsd > cap) {
    const msg = `Estimated $${estimatedMonthlyUsd}/mo exceeds the $${cap}/mo cap.`;
    if (onExceed === "block") {
      blocked = true;
      warnings.push(`${msg} Blocked by guardrail (onExceed: block).`);
    } else {
      warnings.push(`${msg} Proceeding with a warning (onExceed: warn).`);
    }
  }

  return {
    estimatedMonthlyUsd,
    currency,
    ...(cap !== undefined ? { monthlyCapUsd: cap } : {}),
    ...(budget?.classification ? { classification: budget.classification } : {}),
    warnings,
    blocked,
  };
}

// ---------------------------------------------------------------------------
// Confirmations & warnings
// ---------------------------------------------------------------------------

/**
 * Capabilities {@link buildResources} knows how to resolve into Azure resources
 * (mirrors the switch cases). Any `needs[]` capability outside this set falls
 * through the resolver's `default:` no-op and must be surfaced as a confirm card
 * rather than silently dropped — the spec's open-capability contract
 * (SPEC.md §4: "planners that don't understand one should surface it as a
 * confirm card rather than fail"). azx's own read-repo path only ever emits
 * these known capabilities, but a hand-authored / third-party intent (or the
 * future MCP `plan` tool) can carry anything.
 */
const RESOLVABLE_CAPABILITIES: ReadonlySet<CapabilityName> = new Set<CapabilityName>([
  "web-compute",
  "transactional-relational",
  "chat-model",
  "embeddings",
  "search-index",
  "object-storage",
  "background-jobs",
]);

function buildPlanConfirmations(
  intent: AppIntent,
  needs: Need[],
  region: string,
  pinned: boolean,
  guardrails?: Guardrails,
): Confirmation[] {
  const byId = new Map<string, Confirmation>();
  for (const c of intent.confirmations) byId.set(c.id, c);

  // Region confirm when not guardrail-pinned.
  if (!pinned) {
    byId.set("region", {
      id: "region",
      question: `Deploy to ${region}?`,
      confidence: "medium",
      why: "No allowed-regions guardrail was found, so the MVP default region is used.",
      options: [region, "westeurope", "swedencentral", "westus3"],
      assumption: region,
    });
  }

  // Unknown/unresolvable capability → the resolver produced no resource for it.
  // Surface it as a confirm card (never a silent drop) so external emitters and
  // the future MCP `plan` tool get an honest signal.
  for (const need of needs) {
    if (RESOLVABLE_CAPABILITIES.has(need.capability)) continue;
    const id = `capability:${need.capability}:unresolved`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      capability: need.capability,
      question:
        `azx has no resolver for capability '${need.capability}' yet — confirm how it should ` +
        `be provisioned (or provide an escape-hatch declarative file).`,
      confidence: "low",
      why:
        `The App Intent requested '${need.capability}', which is outside the MVP corpus, ` +
        `so no Azure resource was resolved for it.`,
      options: ["Provide an escape-hatch declarative file", "Skip this capability"],
      assumption: "Skip this capability",
    });
  }

  // pgvector present → offer Azure AI Search as an alternative (medium).
  const pgvector = needs.some((n) => n.capability === "transactional-relational" && n.options?.pgvector === true);
  if (pgvector) {
    byId.set("capability:embeddings:store", {
      id: "capability:embeddings:store",
      capability: "embeddings",
      question: "Vector search is served by pgvector in Postgres. Use Azure AI Search instead?",
      confidence: "medium",
      why: "pgvector keeps vectors in the database (cheaper, one less service); Azure AI Search adds hybrid/semantic ranking.",
      options: ["Keep pgvector", "Use Azure AI Search"],
      assumption: "Keep pgvector",
    });
  }

  for (const need of needs) {
    if (need.capability !== "chat-model") continue;
    const provider = typeof need.options?.provider === "string" ? need.options.provider.toLowerCase() : undefined;
    if (!isAzureOpenAIProvider(need)) {
      byId.set("capability:chat-model:provider", {
        id: "capability:chat-model:provider",
        capability: "chat-model",
        question: `Provider '${provider ?? "unknown"}' cannot be provisioned as Azure OpenAI. Choose a supported Azure target.`,
        confidence: "low",
        why: "azx will not translate Anthropic/Claude or an unknown provider into an Azure OpenAI account.",
        options: ["Use Azure OpenAI", "Provide a provider-specific escape hatch"],
      });
    } else if (selectedModels(need, guardrails).length === 0) {
      byId.set("capability:chat-model:model", {
        id: "capability:chat-model:model",
        capability: "chat-model",
        question: "No deployable model was resolved. Choose an Azure OpenAI model deployment.",
        confidence: "low",
        why: "Creating an empty Azure OpenAI account would not satisfy the application.",
      });
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildWarnings(needs: Need[], guardrails?: Guardrails): string[] {
  const warnings: string[] = [];
  // If a guardrail allow-list removed every model from a chat-model need, flag it.
  if (guardrails?.approvedModels?.length) {
    const allow = new Set(guardrails.approvedModels.map((m) => m.toLowerCase()));
    for (const need of needs) {
      if (need.capability !== "chat-model") continue;
      const models = Array.isArray(need.options?.models) ? (need.options!.models as string[]) : [];
      if (models.length > 0 && models.every((m) => !allow.has(m.toLowerCase()))) {
        warnings.push(
          "Every detected chat model was filtered out by the approved-models guardrail; no Azure OpenAI resources will be created.",
        );
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Plain-English summary
// ---------------------------------------------------------------------------

function buildSummary(
  intent: AppIntent,
  resources: AzureResource[],
  region: string,
  planBudget: PlanBudget,
  budget: BudgetContext | undefined,
): string[] {
  const lines: string[] = [];
  const primary = resources.filter((r) => r.capability); // skip the env / wiring-only nodes
  lines.push(
    `${intent.app.name}: resolved ${resources.length} Azure resource(s) across ${primary.length} capability slot(s) in ${region} (dry-run).`,
  );
  for (const r of resources) {
    const sku = r.sku ? ` [${r.sku}]` : "";
    const cost = r.estimatedMonthlyUsd ? ` advisory ~$${r.estimatedMonthlyUsd}/mo` : " usage-based/estimate unavailable";
    lines.push(`  • ${r.service}${sku} as "${r.name}"${cost}`);
  }
  lines.push(
    `Advisory modeled total: ~$${planBudget.estimatedMonthlyUsd}/mo ${planBudget.currency}` +
      (planBudget.monthlyCapUsd !== undefined ? ` (cap $${planBudget.monthlyCapUsd}/mo)` : "") +
      ".",
  );
  const budgetNote = describeBudget(budget);
  if (budgetNote) lines.push(budgetNote);
  return lines;
}

function isAzureOpenAIProvider(need: Need): boolean {
  const provider = typeof need.options?.provider === "string" ? need.options.provider.toLowerCase() : undefined;
  return provider === "openai" || provider === "azure-openai";
}

function selectedModels(need: Need, guardrails?: Guardrails): string[] {
  const models = Array.isArray(need.options?.models)
    ? need.options.models.filter((m): m is string => typeof m === "string" && m.length > 0)
    : [];
  if (!guardrails?.approvedModels?.length) return models;
  const allow = new Set(guardrails.approvedModels.map((m) => m.toLowerCase()));
  return models.filter((m) => allow.has(m.toLowerCase()));
}
