/**
 * Offline plan diff — the engine behind `azx what-if`.
 *
 * Given a baseline {@link AzurePlan} (a previously-saved azx plan) and a freshly
 * resolved target plan, compute a Terraform-style change set: which resources
 * are created, modified, destroyed, or unchanged, with field-level deltas for
 * the modified ones.
 *
 * This is deliberately pure and offline. azx never reads live Azure state, so
 * "what does the world look like now" is always represented by an explicit
 * baseline plan the caller supplies (or nothing, which means greenfield — every
 * target resource is a `create`). No network, no clock, no globals.
 */

import type {
  AzurePlan,
  AzureResource,
  ChangeAction,
  FieldDelta,
  PlanDiff,
  ResourceChange,
} from "./types.js";

/** Scalar resource fields compared verbatim for a `modify`. */
const SCALAR_FIELDS = [
  "name",
  "type",
  "service",
  "sku",
  "region",
  "capability",
  "estimatedMonthlyUsd",
] as const;

/**
 * Diff a target plan against a baseline. A `null`/empty baseline is treated as
 * greenfield: every resource in the target is a `create`.
 */
export function diffPlans(
  baseline: AzurePlan | null | undefined,
  target: AzurePlan,
): PlanDiff {
  const baseResources = baseline?.resources ?? [];
  const isGreenfield = baseResources.length === 0;

  const baseById = indexById(baseResources);
  const targetById = indexById(target.resources);

  const changes: ResourceChange[] = [];

  // Creates and modifies/no-change: iterate the target in its own order.
  for (const res of target.resources) {
    const prior = baseById.get(res.id);
    if (!prior) {
      changes.push({
        action: "create",
        id: res.id,
        type: res.type,
        service: res.service,
        after: res,
      });
      continue;
    }
    const deltas = diffResource(prior, res);
    if (deltas.length === 0) {
      changes.push({
        action: "no-change",
        id: res.id,
        type: res.type,
        service: res.service,
        before: prior,
        after: res,
      });
    } else {
      changes.push({
        action: "modify",
        id: res.id,
        type: res.type,
        service: res.service,
        deltas,
        before: prior,
        after: res,
      });
    }
  }

  // Destroys: baseline resources absent from the target, in baseline order.
  for (const prior of baseResources) {
    if (!targetById.has(prior.id)) {
      changes.push({
        action: "destroy",
        id: prior.id,
        type: prior.type,
        service: prior.service,
        before: prior,
      });
    }
  }

  changes.sort(byActionThenId);

  return {
    changes,
    summary: tally(changes),
    region: target.region,
    baseline: isGreenfield ? "greenfield" : "plan",
  };
}

/** Stable presentation order: creates, modifies, destroys, then no-change. */
const ACTION_ORDER: Record<ChangeAction, number> = {
  create: 0,
  modify: 1,
  destroy: 2,
  "no-change": 3,
};

function byActionThenId(a: ResourceChange, b: ResourceChange): number {
  const byAction = ACTION_ORDER[a.action] - ACTION_ORDER[b.action];
  return byAction !== 0 ? byAction : a.id.localeCompare(b.id);
}

function indexById(resources: AzureResource[]): Map<string, AzureResource> {
  const map = new Map<string, AzureResource>();
  for (const r of resources) map.set(r.id, r);
  return map;
}

/**
 * Field-level deltas between two versions of the same resource (matched by id).
 * `notes` is intentionally excluded — it is advisory plan-time commentary, not
 * a deployable property, and would only add churn to the diff.
 */
function diffResource(
  before: AzureResource,
  after: AzureResource,
): FieldDelta[] {
  const deltas: FieldDelta[] = [];

  for (const field of SCALAR_FIELDS) {
    const b = before[field];
    const a = after[field];
    if (b !== a) deltas.push({ field, before: b, after: a });
  }

  // dependsOn — order-insensitive array compare.
  if (!sameStringSet(before.dependsOn, after.dependsOn)) {
    deltas.push({
      field: "dependsOn",
      before: before.dependsOn,
      after: after.dependsOn,
    });
  }

  // properties — deep structural compare, reported as a single delta.
  if (stableStringify(before.properties) !== stableStringify(after.properties)) {
    deltas.push({
      field: "properties",
      before: before.properties,
      after: after.properties,
    });
  }

  return deltas;
}

function sameStringSet(a?: string[], b?: string[]): boolean {
  const sa = [...(a ?? [])].sort();
  const sb = [...(b ?? [])].sort();
  if (sa.length !== sb.length) return false;
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Deterministic JSON with recursively sorted object keys, so two structurally
 * equal `properties` objects compare equal regardless of key insertion order.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function tally(changes: ResourceChange[]): PlanDiff["summary"] {
  const summary = { create: 0, modify: 0, destroy: 0, noChange: 0 };
  for (const c of changes) {
    if (c.action === "create") summary.create++;
    else if (c.action === "modify") summary.modify++;
    else if (c.action === "destroy") summary.destroy++;
    else summary.noChange++;
  }
  return summary;
}
