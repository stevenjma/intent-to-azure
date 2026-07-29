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
import { describeBudget, prefersEconomy } from "./budget.js";
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
  const confirmations = buildPlanConfirmations(intent, needs, region, pinnedByGuardrail);
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
        resources.push(...buildChatModel(need, ctx, guardrails?.approvedModels));
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
  const storageToken = ("st" + slug.replace(/-/g, "")).slice(0, 24);
  for (const r of resources) {
    if (!r.name.includes("${appName}")) continue;
    if (r.type === "Microsoft.Storage/storageAccounts") {
      r.name = storageToken;
    } else {
      r.name = r.name.replace(/\$\{appName\}/g, slug);
      // Container Apps and Jobs names must be <=32 chars (lowercase alnum/hyphen,
      // start letter, end alnum). Clamp deterministically with a stable hash suffix.
      if (r.type === "Microsoft.App/containerApps" || r.type === "Microsoft.App/jobs") {
        r.name = clampName(r.name, 32);
      }
    }
  }
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
          "Every detected chat model was filtered out by the approved-models guardrail; the Azure OpenAI account has no deployments.",
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
    const cost = r.estimatedMonthlyUsd ? ` ~$${r.estimatedMonthlyUsd}/mo` : "";
    lines.push(`  • ${r.service}${sku} as "${r.name}"${cost}`);
  }
  lines.push(
    `Estimated total: ~$${planBudget.estimatedMonthlyUsd}/mo ${planBudget.currency}` +
      (planBudget.monthlyCapUsd !== undefined ? ` (cap $${planBudget.monthlyCapUsd}/mo)` : "") +
      ".",
  );
  const budgetNote = describeBudget(budget);
  if (budgetNote) lines.push(budgetNote);
  return lines;
}
