/**
 * Stage [3] run + watch — INTERFACE / STUB ONLY.
 *
 * POC #1 is a dry-run engine: it generates and previews, but never deploys.
 * This module defines the seam a future POC will implement (real `az deployment`
 * / SDK calls) without changing the library shape. The default implementation
 * only prints what *would* happen. No Azure calls. No network.
 */

import type { AzurePlan } from "./types.js";

export interface RunOptions {
  /** Target resource group (informational in the stub). */
  resourceGroup?: string;
  /** Subscription id (informational in the stub). */
  subscriptionId?: string;
}

export interface RunResult {
  /** Always true in POC #1. */
  dryRun: boolean;
  /** Whether a guardrail `block` prevented even a simulated run. */
  blocked: boolean;
  /** Human-readable, line-by-line account of what would happen. */
  steps: string[];
}

/**
 * The deployment seam. A future POC provides a real implementation; the library
 * and CLI depend only on this interface so nothing else has to change.
 */
export interface Deployer {
  run(plan: AzurePlan, bicep: string, opts?: RunOptions): Promise<RunResult>;
}

/** The only deployer in POC #1: it explains the plan, then stops. */
export class DryRunDeployer implements Deployer {
  async run(plan: AzurePlan, bicep: string, opts: RunOptions = {}): Promise<RunResult> {
    return dryRun(plan, bicep, opts);
  }
}

/** Synchronous convenience used by `azx up` — produces the "would deploy" report. */
export function dryRun(plan: AzurePlan, bicep: string, opts: RunOptions = {}): RunResult {
  const blocked = plan.budget?.blocked === true;
  const rg = opts.resourceGroup ?? "rg-<your-app>";
  const steps: string[] = [];

  steps.push("stage [3] run + watch — DRY RUN (no Azure calls made)");
  steps.push(`would target resource group: ${rg} in ${plan.region}`);

  if (blocked) {
    steps.push("BLOCKED: a spend guardrail (onExceed: block) tripped — refusing to simulate a deploy.");
    for (const w of plan.budget?.warnings ?? []) steps.push(`  • ${w}`);
    return { dryRun: true, blocked: true, steps };
  }

  steps.push(`would deploy ${plan.resources.length} resource(s):`);
  for (const r of plan.resources) {
    const dep = r.dependsOn?.length ? ` (after ${r.dependsOn.join(", ")})` : "";
    steps.push(`  • ${r.service} → ${r.name}${dep}`);
  }
  steps.push(`would submit ${bicep.split("\n").length}-line main.bicep to the resource group`);
  steps.push("would then watch deployment status until every resource is Provisioned");
  steps.push("STUB: real deployment is out of scope for POC #1. Run with a future azx to apply.");

  return { dryRun: true, blocked: false, steps };
}
