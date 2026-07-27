/**
 * azx core contract types — the "App Intent" vocabulary.
 *
 * These types define the OPEN, capability-shaped contract behind `POST /v1/intent`.
 * The request describes *what an app needs* (provider-agnostic capabilities).
 * The response is the *resolved Azure resource graph* (provider-specific).
 *
 * Nothing here is Azure-specific except {@link AzurePlan} / {@link AzureResource},
 * which are deliberately kept separate from the capability vocabulary so the same
 * intent can be resolved to other providers in the future.
 */

// ---------------------------------------------------------------------------
// Capability vocabulary
// ---------------------------------------------------------------------------

/** Known capability names. New capabilities slot in without breaking existing ones. */
export type KnownCapability =
  | "web-compute"
  | "transactional-relational"
  | "chat-model"
  | "embeddings"
  | "search-index"
  | "object-storage"
  | "background-jobs";

/**
 * A capability name. Extendable: the union documents the MVP corpus, but any
 * string is accepted so third parties can introduce new capabilities.
 */
export type CapabilityName = KnownCapability | (string & {});

/** Confidence tiers from the confidence model. */
export type Confidence = "high" | "medium" | "low";

// ---------------------------------------------------------------------------
// Stage 0 — signals
// ---------------------------------------------------------------------------

/**
 * Independence bucket for a signal. Two signals of *different* kind pointing at
 * the same capability count as independent corroboration (→ high confidence).
 */
export type SignalKind =
  | "dependency" // a package manifest / lockfile dependency
  | "import" // a source-level import / usage
  | "env" // an environment variable (DATABASE_URL, *_API_KEY, ...)
  | "migration" // a database migration / schema file
  | "config" // a framework or tool config file
  | "framework-file" // a file whose mere presence implies a framework
  | "dockerfile" // a Dockerfile / container definition
  | "ci" // a CI/CD workflow (e.g. GitHub Actions)
  | "manifest"; // repo-level manifest metadata (name, scripts, ...)

/** A single observation made while reading the repo (stage 0). */
export interface Signal {
  /** Independence bucket used when counting corroborating evidence. */
  kind: SignalKind;
  /** What we actually observed, e.g. `package.json depends on "next"`. */
  signal: string;
  /** What it implies in plain English, e.g. `web-compute (Next.js app)`. */
  conclusion: string;
  /** The capability this signal points to, if any. */
  capability?: CapabilityName;
  /** Structured extras carried forward into planning (framework, version, ...). */
  detail?: Record<string, unknown>;
  /**
   * A weak signal is suggestive but not sufficient on its own: a lone weak
   * signal yields `low` confidence (ask once) rather than `medium`.
   */
  weak?: boolean;
  /** Repo-relative path the signal was read from, for traceability. */
  from?: string;
}

// ---------------------------------------------------------------------------
// App Intent — the capability-shaped request
// ---------------------------------------------------------------------------

/** Options for `transactional-relational`. */
export interface RelationalOptions {
  /** Database branching (e.g. Neon-style) requested. */
  branching?: boolean;
  /** Desired consistency posture. */
  consistency?: "strong" | "eventual";
  /** Vector search served in-database via pgvector (keeps it out of AI Search). */
  pgvector?: boolean;
  /** Detected engine, currently always postgres in the MVP corpus. */
  engine?: "postgres";
}

/** Options for `chat-model` / `embeddings`. */
export interface ModelOptions {
  /** Provider observed in the repo (informational; planning maps to Azure). */
  provider?: "openai" | "azure-openai" | "anthropic" | (string & {});
  /** Model identifiers observed in the repo. */
  models?: string[];
}

/** A single capability the app needs. This is the unit of the open contract. */
export interface Need {
  /** The capability requested. */
  capability: CapabilityName;
  /** Capability-specific options (see {@link RelationalOptions}, {@link ModelOptions}). */
  options?: RelationalOptions & ModelOptions & Record<string, unknown>;
  /** Derived confidence for this need (from the confidence model). */
  confidence: Confidence;
  /** Plain-English justification. */
  rationale: string;
  /** Human-readable summaries of the signals that produced this need. */
  evidence: string[];
}

/** Minimal description of the app under inspection. */
export interface AppInfo {
  /** Best-effort app name (from manifest, else directory name). */
  name: string;
  /** Absolute or repo-relative root that was scanned. */
  root: string;
  /** Primary framework, if detected (nextjs, fastapi, django, ...). */
  framework?: string;
  /** Primary language, if detected (typescript, javascript, python, ...). */
  language?: string;
  /** Runtime hint (node, python, ...). */
  runtime?: string;
}

/**
 * The OPEN contract request body for `POST /v1/intent`.
 * Capability-shaped and provider-agnostic — this is what a third party emits.
 */
export interface IntentRequest {
  /** Contract version. */
  version: "0.1";
  app: AppInfo;
  /** The capabilities the app needs. */
  needs: Need[];
  /** Optional guardrails to apply (policy wins over repo signals). */
  guardrails?: Guardrails;
  /** Optional budget context (subscription offer id, spend cap, ...). */
  budget?: BudgetContext;
}

/**
 * The enriched App Intent document produced by the engine. It embeds an
 * {@link IntentRequest} and adds the evidence trail the engine reasoned from.
 */
export interface AppIntent extends IntentRequest {
  /** Every observation made in stage 0, for the signals table. */
  signals: Signal[];
  /** Medium/low-confidence items to confirm before applying. */
  confirmations: Confirmation[];
  meta: {
    generatedBy: "azx";
    generatedAt: string;
    /** Which pipeline stages contributed to this document. */
    stages: string[];
  };
}

// ---------------------------------------------------------------------------
// Confirmations (confirm cards)
// ---------------------------------------------------------------------------

/**
 * A confirm card. Only `medium` (1 signal) and `low` (weak/absent) items are
 * surfaced; `high`-confidence conclusions are applied without asking.
 */
export interface Confirmation {
  /** Stable id, e.g. `region`, `capability:embeddings`. */
  id: string;
  /** The capability the question is about, if applicable. */
  capability?: CapabilityName;
  /** The question to put to the developer. */
  question: string;
  /** Confidence that triggered the card. */
  confidence: Confidence;
  /** Why we are asking, in plain English. */
  why: string;
  /** Optional discrete choices. */
  options?: string[];
  /** The engine's current assumption if the developer does nothing. */
  assumption?: string;
}

// ---------------------------------------------------------------------------
// Stage 1 — guardrails
// ---------------------------------------------------------------------------

/** Parsed `guardrails.yaml`. Guardrails win when repo and policy disagree. */
export interface Guardrails {
  /** Allowed Azure regions; the first is the preferred default. */
  regions?: string[];
  /** Allow-list of model identifiers; models outside it are rejected. */
  approvedModels?: string[];
  /** Spend controls. */
  budget?: {
    /** Monthly cap in USD. */
    monthlyCapUsd?: number;
    /** What to do when the estimate exceeds the cap. */
    onExceed?: "warn" | "block";
  };
  /** Preferred SKU tier bias applied across resources. */
  skuTier?: "economy" | "standard";
  /** Free-form notes surfaced in the plan. */
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Budget context, normally read from the subscription. In this POC it is mocked
 * from an `.azx/subscription.json` fixture — no real Azure calls.
 */
export interface BudgetContext {
  /** Subscription id (mock). */
  subscriptionId?: string;
  /** Azure Offer ID, e.g. `MS-AZR-0036P` (sponsorship). */
  offerId?: string;
  /** Whether a spending limit is active on the subscription. */
  spendingLimit?: "on" | "off" | "unknown";
  /** Classification derived from the offer id. */
  classification?: "sponsorship" | "free-trial" | "pay-as-you-go" | "enterprise" | "unknown";
  /** Currency for estimates. */
  currency?: string;
}

// ---------------------------------------------------------------------------
// Stage 2 — the resolved Azure plan (provider-specific)
// ---------------------------------------------------------------------------

/** A single resolved Azure resource in the plan graph. */
export interface AzureResource {
  /** Stable logical id used for `dependsOn` wiring and Bicep symbol names. */
  id: string;
  /** Human/Azure resource name (may include a token placeholder). */
  name: string;
  /** ARM resource type, e.g. `Microsoft.App/containerApps`. */
  type: string;
  /** Friendly service label, e.g. `Azure Container Apps`. */
  service: string;
  /** SKU / tier if applicable. */
  sku?: string;
  /** Azure region. */
  region: string;
  /** Capability this resource satisfies. */
  capability?: CapabilityName;
  /** Logical ids this resource depends on. */
  dependsOn?: string[];
  /** Rough, non-binding monthly cost estimate in USD. */
  estimatedMonthlyUsd?: number;
  /** Plan-time notes (fallbacks considered, guardrail effects, ...). */
  notes?: string[];
  /** Extra structured properties for Bicep generation. */
  properties?: Record<string, unknown>;
}

/** Budget summary attached to the plan. */
export interface PlanBudget {
  estimatedMonthlyUsd: number;
  currency: string;
  monthlyCapUsd?: number;
  classification?: BudgetContext["classification"];
  /** Burn / cap warnings. */
  warnings: string[];
  /** True if a `block` guardrail was tripped. */
  blocked: boolean;
}

/**
 * The resolved Azure resource graph — the response body of `POST /v1/intent`.
 */
export interface AzurePlan {
  /** Region the plan resolves to. */
  region: string;
  /** The resolved resource graph. */
  resources: AzureResource[];
  /** Plain-English, line-by-line summary of the plan. */
  summary: string[];
  /** Confirmations still outstanding (carried from the intent). */
  confirmations: Confirmation[];
  /** Effects of applied guardrails, in plain English. */
  guardrailNotes: string[];
  /** Non-fatal warnings. */
  warnings: string[];
  budget: PlanBudget;
  meta: {
    generatedBy: "azx";
    generatedAt: string;
    /** Whether this is a dry-run (always true in POC #1). */
    dryRun: boolean;
  };
}

/** Full `POST /v1/intent` response: the intent we resolved + the Azure graph. */
export interface IntentResponse {
  intent: AppIntent;
  plan: AzurePlan;
}

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

/** Injectable clock so pure functions stay deterministic under test. */
export interface ClockOptions {
  /** Returns "now". Defaults to `() => new Date()` in the CLI. */
  now?: () => Date;
}
