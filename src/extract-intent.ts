/**
 * Stage [0.5] extract-intent — turn raw signals into the open App Intent.
 *
 * We group the stage-0 signals by capability, apply the confidence model, and
 * emit a capability-shaped {@link AppIntent}: `needs[]` + the evidence trail +
 * confirm cards for anything below `high` confidence. Pure and deterministic —
 * inject a clock via {@link ClockOptions} to pin `meta.generatedAt` under test.
 */

import { deriveConfidence, groupByCapability } from "./confidence.js";
import type { RepoScan } from "./read-repo.js";
import type {
  AppIntent,
  BudgetContext,
  CapabilityName,
  ClockOptions,
  Confidence,
  Confirmation,
  Guardrails,
  Need,
  Signal,
} from "./types.js";

export interface ExtractOptions extends ClockOptions {
  /** Optional guardrails to embed in the intent (applied later, in plan()). */
  guardrails?: Guardrails;
  /** Optional budget context to embed in the intent. */
  budget?: BudgetContext;
  /** Explicit hosting-class override for ambiguous or externally confirmed cases. */
  hostingOverride?: "static" | "server";
}

/** Deterministic capability ordering for stable output. */
const CAPABILITY_ORDER: CapabilityName[] = [
  "static-hostable-frontend",
  "http-server-runtime",
  "client-only-persistence",
  "web-compute",
  "transactional-relational",
  "chat-model",
  "embeddings",
  "search-index",
  "object-storage",
  "background-jobs",
];

function capRank(cap: CapabilityName): number {
  const i = CAPABILITY_ORDER.indexOf(cap);
  return i === -1 ? CAPABILITY_ORDER.length : i;
}

/** Build the App Intent document from a repo scan. */
export function extractIntent(scan: RepoScan, opts: ExtractOptions = {}): AppIntent {
  const now = opts.now ?? (() => new Date());
  const groups = groupByCapability(scan.signals);

  const needs: Need[] = [];
  for (const [capability, signals] of groups) {
    needs.push(buildNeed(capability, signals));
  }

  postProcessVectorStore(needs);
  postProcessHosting(needs, opts.hostingOverride);
  needs.sort((a, b) => capRank(a.capability) - capRank(b.capability) || a.capability.localeCompare(b.capability));

  const confirmations = buildConfirmations(needs);

  return {
    version: "0.1",
    app: scan.app,
    needs,
    ...(opts.guardrails ? { guardrails: opts.guardrails } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
    signals: scan.signals,
    confirmations,
    meta: {
      generatedBy: "azx",
      generatedAt: now().toISOString(),
      stages: ["read-repo", "extract-intent"],
    },
  };
}

// ---------------------------------------------------------------------------
// Need construction
// ---------------------------------------------------------------------------

function buildNeed(capability: CapabilityName, signals: Signal[]): Need {
  const confidence = deriveConfidence(signals);
  const options = mergeOptions(signals);
  const evidence = [...new Set(signals.map((s) => s.signal))].sort((a, b) => a.localeCompare(b));
  const rationale = buildRationale(capability, signals, confidence);

  return {
    capability,
    ...(Object.keys(options).length ? { options } : {}),
    confidence,
    basis: capability === "static-hostable-frontend" ? "inferred" : "observed",
    rationale,
    evidence,
    assumptions:
      capability === "static-hostable-frontend"
        ? ["Static export eligibility is inferred from repository signals and must be verified by the CI build."]
        : [],
  };
}

/** Merge per-signal `detail` into a single capability options object. */
function mergeOptions(signals: Signal[]): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const models = new Set<string>();
  let provider: unknown;

  for (const s of signals) {
    const d = s.detail;
    if (!d) continue;
    if (d.option === "pgvector") {
      options.pgvector = true;
      options.engine = "postgres";
    }
    if (d.engine) options.engine = d.engine;
    if (d.branching) options.branching = true;
    if (d.consistency) options.consistency = d.consistency;
    if (d.requiredArtifact) options.requiredArtifact = d.requiredArtifact;
    if (d.persistence) options.persistence = d.persistence;
    if (d.hostingAmbiguity) options.hostingAmbiguity = true;
    if (d.staticExportDisqualifier) options.staticExportDisqualifier = d.staticExportDisqualifier;
    if (typeof d.provider === "string" && provider === undefined) provider = d.provider;
    if (Array.isArray(d.models)) for (const m of d.models) models.add(String(m));
  }

  if (provider !== undefined) options.provider = provider;
  if (models.size) options.models = [...models].sort((a, b) => a.localeCompare(b));
  return options;
}

function postProcessHosting(needs: Need[], override?: "static" | "server"): void {
  if (override) {
    for (let i = needs.length - 1; i >= 0; i--) {
      if (["static-hostable-frontend", "http-server-runtime", "web-compute"].includes(needs[i]!.capability)) {
        needs.splice(i, 1);
      }
    }
    const capability = override === "static" ? "static-hostable-frontend" : "http-server-runtime";
    needs.push({
      capability,
      confidence: "high",
      basis: "user-confirmed",
      rationale: `Hosting class explicitly overridden to ${override}.`,
      evidence: [`Explicit hosting override: ${override}`],
      assumptions:
        override === "static"
          ? ["Static export must still be verified by the generated CI build."]
          : ["A deployable application container image must be supplied."],
      options: { requiredArtifact: override === "static" ? "static-directory" : "container-image" },
    });
    return;
  }
  const server = needs.find((n) => n.capability === "http-server-runtime");
  const staticIndex = needs.findIndex((n) => n.capability === "static-hostable-frontend");
  if (server && staticIndex >= 0) needs.splice(staticIndex, 1);
  const genericCompute = needs.findIndex((n) => n.capability === "web-compute");
  if ((server || staticIndex >= 0) && genericCompute >= 0) needs.splice(genericCompute, 1);
  const hosting = server ?? needs.find((n) => n.capability === "static-hostable-frontend");
  if (hosting) {
    hosting.options = {
      ...(hosting.options ?? {}),
      requiredArtifact: server ? "container-image" : "static-directory",
    };
  }
}

function buildRationale(capability: CapabilityName, signals: Signal[], confidence: Confidence): string {
  const kinds = [...new Set(signals.map((s) => s.kind))].sort();
  const kindPhrase =
    kinds.length >= 2
      ? `${kinds.length} independent signals (${kinds.join(", ")})`
      : `a single ${kinds[0] ?? "unknown"} signal`;
  const conclusion = signals[0]?.conclusion ?? capability;
  if (capability === "http-server-runtime" && signals.some((signal) => signal.detail?.staticExportDisqualifier)) {
    return `${conclusion}: an explicit static-export disqualifier requires server compute, so it is applied without asking.`;
  }
  const tail =
    confidence === "high"
      ? "corroborated across signal kinds, so it is applied without asking."
      : confidence === "medium"
        ? "seen once, so it is surfaced as a confirm card."
        : "only a weak hint, so it is asked once before applying.";
  return `${conclusion}: ${kindPhrase} point at ${capability}; ${tail}`;
}

/**
 * pgvector resolves the vector store *inside* Postgres. If the app also needs
 * embeddings, annotate that it is served by pgvector and don't let it imply a
 * separate Azure AI Search. If embeddings are needed with neither pgvector nor
 * an explicit search SDK, planning will raise a confirm card (handled there).
 */
function postProcessVectorStore(needs: Need[]): void {
  const relational = needs.find((n) => n.capability === "transactional-relational");
  const embeddings = needs.find((n) => n.capability === "embeddings");
  if (!embeddings) return;

  const pgvector = relational?.options?.pgvector === true;
  if (pgvector) {
    embeddings.options = { ...(embeddings.options ?? {}), servedBy: "pgvector" };
    embeddings.rationale += " Vector store is served in-database by pgvector (no Azure AI Search).";
  }
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

const CONFIRM_QUESTION: Record<string, string> = {
  "static-hostable-frontend": "Treat this application as a static-export candidate?",
  "http-server-runtime": "Deploy the observed HTTP server runtime?",
  "client-only-persistence": "Keep browser-local persistence without provisioning shared state?",
  "web-compute": "Deploy this app as web-compute on Azure Container Apps?",
  "transactional-relational": "Provision an Azure Database for PostgreSQL Flexible Server?",
  "chat-model": "Wire up Azure OpenAI to serve the chat-model usage?",
  "embeddings": "Provision a vector store for embeddings?",
  "search-index": "Provision Azure AI Search for the search index?",
  "object-storage": "Provision Azure Blob Storage for object-storage?",
  "background-jobs": "Run background jobs as an Azure Container Apps Job?",
};

/** medium → confirm card; low → ask once. high → applied silently. */
function buildConfirmations(needs: Need[]): Confirmation[] {
  const confirmations: Confirmation[] = [];

  // Zero-detection escape hatch: an out-of-corpus repo yields no capabilities.
  // Surface an explicit coverage notice rather than emitting a near-empty plan
  // with no caveat (README: "Anything outside the MVP corpus surfaces as a
  // confirmation card or an escape-hatch declarative file — never a silent
  // wrong guess."). Fully-recognized repos have needs, so this never fires there.
  if (needs.length === 0) {
    confirmations.push({
      id: "coverage:no-detection",
      question:
        "azx did not recognize this stack (no known frameworks/databases/AI usage detected). " +
        "Provide an escape-hatch declarative intent, or confirm the app's needs.",
      confidence: "low",
      why: "No capability signals were detected while scanning the repo.",
      options: ["Provide an escape-hatch declarative intent", "Confirm the app's needs manually"],
      assumption: "Provide an escape-hatch declarative intent",
    });
  }

  for (const need of needs) {
    if (need.capability === "client-only-persistence") continue;
    if (need.capability === "http-server-runtime") continue;
    if (need.capability === "static-hostable-frontend") {
      if (need.options?.hostingAmbiguity !== true) continue;
      confirmations.push({
        id: "hosting:static-export",
        capability: need.capability,
        question: "Do the configured rewrites or redirects require runtime request handling?",
        confidence: "medium",
        why: "The routing configuration is ambiguous and the answer changes Static Web Apps versus server compute.",
        options: ["No, they are static-compatible", "Yes, they require a server"],
        assumption: "No, they are static-compatible",
      });
      continue;
    }
    if (need.confidence === "high") continue;

    // Embeddings without a resolved store is a genuine either/or question.
    if (need.capability === "embeddings" && need.options?.servedBy !== "pgvector") {
      confirmations.push({
        id: `capability:embeddings`,
        capability: "embeddings",
        question: "Where should embeddings be stored — pgvector in Postgres, or Azure AI Search?",
        confidence: need.confidence,
        why: "Embeddings usage was detected but no vector store was found in the repo.",
        options: ["pgvector (in Postgres)", "Azure AI Search"],
        assumption: "Azure AI Search",
      });
      continue;
    }

    confirmations.push({
      id: `capability:${need.capability}`,
      capability: need.capability,
      question: CONFIRM_QUESTION[need.capability] ?? `Provision Azure resources for ${need.capability}?`,
      confidence: need.confidence,
      why:
        need.confidence === "medium"
          ? `Only one signal pointed at ${need.capability}.`
          : `Only a weak hint pointed at ${need.capability}.`,
      options: ["Yes", "No"],
      assumption: "Yes",
    });
  }
  confirmations.sort((a, b) => a.id.localeCompare(b.id));
  return confirmations;
}
