/**
 * azx browser engine — the node-free subset of the public surface, for the Pages SPA.
 *
 * The Node barrel (`index.ts`) re-exports `az-deploy`/`ledger`/`ship`/`read-repo`,
 * which pull `node:child_process`/`node:fs`; importing it in a browser fails. This
 * barrel re-exports ONLY modules proven free of transitive `node:` imports, so a
 * static page can `import` the compiled `dist/src/web-engine.js` directly (no
 * bundler). The SPA feeds a `Map<path, contents>` fetched over the GitHub REST API
 * to {@link resolveScan}, which runs the same detection → intent → plan → bicep →
 * scaffold pipeline the CLI runs on disk.
 */

export * from "./types.js";

export { scanFileMap } from "./scan-core.js";

export { deriveConfidence, deriveConfidences, groupByCapability } from "./confidence.js";

export { extractIntent } from "./extract-intent.js";
export type { ExtractOptions } from "./extract-intent.js";

export { classifyOffer, normalizeBudget, prefersEconomy, describeBudget } from "./budget-core.js";

export { plan, DEFAULT_REGION, slugifyRegion, planNeedsPgPassword } from "./plan.js";
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

export { generateArmTemplate } from "./arm-template.js";

export { diffPlans } from "./diff.js";

export { buildScaffold, resourceGroupFor, slugify } from "./scaffold.js";
export type { ScaffoldFile, ScaffoldOptions } from "./scaffold.js";

export {
  isDeployLedger,
  RESOURCE_GROUP_RE,
  REGION_RE,
  DEPLOYMENT_NAME_RE,
  SUBSCRIPTION_ID_RE,
  ISO_INSTANT_RE,
  TEMPLATE_HASH_RE,
} from "./ledger-core.js";

import { scanFileMap } from "./scan-core.js";
import { extractIntent, type ExtractOptions } from "./extract-intent.js";
import { plan as planIntent } from "./plan.js";
import { generateBicep } from "./bicep.js";
import { buildScaffold, type ScaffoldFile, type ScaffoldOptions } from "./scaffold.js";
import type { IntentResponse } from "./types.js";

/** The full offline result the SPA renders: intent, resolved plan, Bicep, and the
 * deployable repo scaffold — identical to what the CLI produces on disk. */
export interface ResolveScanResult extends IntentResponse {
  bicep: string;
  scaffold: ScaffoldFile[];
}

/**
 * Browser end-to-end: a `Map<path, contents>` (fetched from GitHub) → scan → extract
 * intent → resolve plan → Bicep → scaffold. The exact CLI pipeline with the disk read
 * replaced by the pre-fetched file map. Guardrails/budget are optional (the engine
 * handles their absence); pass them through `opts` if the SPA collects them.
 */
export function resolveScan(
  appName: string,
  files: Map<string, string>,
  opts: ExtractOptions & { scaffold?: ScaffoldOptions } = {},
): ResolveScanResult {
  const scan = scanFileMap(appName, files);
  const intent = extractIntent(scan, opts);
  const resolved = planIntent(intent, opts);
  const bicep = generateBicep(resolved);
  const scaffold = buildScaffold(intent, resolved, bicep, opts.scaffold ?? {});
  return { intent, plan: resolved, bicep, scaffold };
}
