/**
 * azx public library surface.
 *
 * The pure, importable engine behind the CLI — and the seam a future MCP server
 * (POC #2) wraps as tools (`scan_repo`, `extract_intent`, `plan`,
 * `generate_bicep`). Nothing here touches the network on the default path.
 *
 *   readRepo()       → stage [0] read-repo   (MCP: scan_repo)
 *   extractIntent()  → stage [0.5] intent    (MCP: extract_intent)
 *   plan()           → stage [2] plan        (MCP: plan)
 *   generateBicep()  → stage [2] bicep       (MCP: generate_bicep)
 *   dryRun()         → stage [3] run+watch   (stub — never deploys)
 */

export * from "./types.js";

export { readRepo } from "./read-repo.js";
export type { RepoScan } from "./read-repo.js";

export { deriveConfidence, deriveConfidences, groupByCapability } from "./confidence.js";

export { extractIntent } from "./extract-intent.js";
export type { ExtractOptions } from "./extract-intent.js";

export { loadGuardrails, parseGuardrails } from "./guardrails.js";
export { loadBudget, classifyOffer, prefersEconomy, describeBudget } from "./budget.js";

export { plan, DEFAULT_REGION, slugifyRegion } from "./plan.js";
export type { PlanOptions } from "./plan.js";

export {
  buildManagedEnvironment,
  buildWebCompute,
  buildRelational,
  buildChatModel,
  buildSearch,
  buildObjectStorage,
  buildBackgroundJobs,
} from "./azure-map.js";
export type { MapContext } from "./azure-map.js";

export { generateBicep } from "./bicep.js";

export { diffPlans } from "./diff.js";

export { DryRunDeployer, dryRun } from "./run.js";
export type { Deployer, RunOptions, RunResult } from "./run.js";

import { readRepo } from "./read-repo.js";
import { extractIntent, type ExtractOptions } from "./extract-intent.js";
import { loadGuardrails } from "./guardrails.js";
import { loadBudget } from "./budget.js";
import { plan as planIntent } from "./plan.js";
import { generateBicep } from "./bicep.js";
import type { IntentResponse } from "./types.js";

/**
 * Convenience end-to-end: read a repo → extract intent → resolve the Azure plan.
 * Loads `guardrails.yaml` and `.azx/subscription.json` from the repo when present
 * (both offline). Returns the full `POST /v1/intent` response shape.
 */
export function resolveRepo(root: string, opts: ExtractOptions = {}): IntentResponse & { bicep: string } {
  const scan = readRepo(root);
  const guardrails = opts.guardrails ?? loadGuardrails(root);
  const budget = opts.budget ?? loadBudget(root);
  const intent = extractIntent(scan, { ...opts, guardrails, budget });
  const resolved = planIntent(intent, { ...opts, guardrails, budget });
  const bicep = generateBicep(resolved);
  return { intent, plan: resolved, bicep };
}
