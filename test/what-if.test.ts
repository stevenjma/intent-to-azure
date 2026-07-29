/**
 * Unit tests for the offline plan diff (`diffPlans`) behind `azx what-if`.
 *
 * These are pure and offline: we hand-build minimal {@link AzurePlan}s and assert
 * the change-set classification (create / modify / destroy / no-change), the
 * field-level deltas, and the roll-up summary. One light integration case diffs a
 * real resolved plan (via {@link resolveRepo}) against itself and against
 * greenfield to prove the engine agrees with real plan shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { diffPlans, resolveRepo } from "../src/index.js";
import type { AzurePlan, AzureResource } from "../src/types.js";

function res(id: string, over: Partial<AzureResource> = {}): AzureResource {
  return {
    id,
    name: id,
    type: "Microsoft.App/containerApps",
    service: "Azure Container Apps",
    region: "eastus2",
    ...over,
  };
}

function plan(resources: AzureResource[], region = "eastus2"): AzurePlan {
  return {
    region,
    resources,
    summary: [],
    confirmations: [],
    guardrailNotes: [],
    warnings: [],
    budget: { estimatedMonthlyUsd: 0, currency: "USD", warnings: [], blocked: false },
    meta: { generatedBy: "azx", generatedAt: "2024-01-01T00:00:00.000Z", dryRun: true },
  };
}

test("greenfield: null baseline makes every resource a create", () => {
  const target = plan([res("web"), res("db", { type: "Microsoft.DBforPostgreSQL/flexibleServers" })]);
  const diff = diffPlans(null, target);

  assert.equal(diff.baseline, "greenfield");
  assert.equal(diff.summary.create, 2);
  assert.equal(diff.summary.modify, 0);
  assert.equal(diff.summary.destroy, 0);
  assert.equal(diff.summary.noChange, 0);
  assert.ok(diff.changes.every((c) => c.action === "create"));
});

test("empty-resources baseline is also greenfield", () => {
  const diff = diffPlans(plan([]), plan([res("web")]));
  assert.equal(diff.baseline, "greenfield");
  assert.equal(diff.summary.create, 1);
});

test("classifies create / modify / destroy / no-change together", () => {
  const baseline = plan([
    res("web", { sku: "Consumption" }),
    res("db"),
    res("cache"),
  ]);
  const target = plan([
    res("web", { sku: "Dedicated-D4" }), // modify (sku)
    res("db"), // no-change
    res("queue"), // create
    // cache dropped -> destroy
  ]);

  const diff = diffPlans(baseline, target);
  assert.equal(diff.baseline, "plan");
  assert.deepEqual(diff.summary, { create: 1, modify: 1, destroy: 1, noChange: 1 });

  const byId = new Map(diff.changes.map((c) => [c.id, c]));
  assert.equal(byId.get("web")?.action, "modify");
  assert.equal(byId.get("db")?.action, "no-change");
  assert.equal(byId.get("queue")?.action, "create");
  assert.equal(byId.get("cache")?.action, "destroy");
});

test("modify carries field-level deltas with before/after", () => {
  const baseline = plan([res("web", { sku: "Consumption", estimatedMonthlyUsd: 10 })]);
  const target = plan([res("web", { sku: "Dedicated-D4", estimatedMonthlyUsd: 85 })]);

  const change = diffPlans(baseline, target).changes.find((c) => c.id === "web");
  assert.equal(change?.action, "modify");
  const fields = new Map((change?.deltas ?? []).map((d) => [d.field, d]));
  assert.deepEqual(fields.get("sku"), { field: "sku", before: "Consumption", after: "Dedicated-D4" });
  assert.deepEqual(fields.get("estimatedMonthlyUsd"), {
    field: "estimatedMonthlyUsd",
    before: 10,
    after: 85,
  });
});

test("dependsOn compares order-insensitively", () => {
  const baseline = plan([res("web", { dependsOn: ["db", "cache"] })]);
  const sameOrderFlipped = plan([res("web", { dependsOn: ["cache", "db"] })]);
  const changed = plan([res("web", { dependsOn: ["db"] })]);

  assert.equal(diffPlans(baseline, sameOrderFlipped).summary.modify, 0);
  const change = diffPlans(baseline, changed).changes.find((c) => c.id === "web");
  assert.equal(change?.action, "modify");
  assert.ok(change?.deltas?.some((d) => d.field === "dependsOn"));
});

test("properties deep-compare ignores key order", () => {
  const baseline = plan([res("web", { properties: { a: 1, nested: { x: 1, y: 2 } } })]);
  const reordered = plan([res("web", { properties: { nested: { y: 2, x: 1 }, a: 1 } })]);
  const mutated = plan([res("web", { properties: { a: 2, nested: { x: 1, y: 2 } } })]);

  assert.equal(diffPlans(baseline, reordered).summary.modify, 0);
  const change = diffPlans(baseline, mutated).changes.find((c) => c.id === "web");
  assert.equal(change?.action, "modify");
  assert.ok(change?.deltas?.some((d) => d.field === "properties"));
});

test("notes differences do not register as a change", () => {
  const baseline = plan([res("web", { notes: ["considered Free tier"] })]);
  const target = plan([res("web", { notes: ["different advisory note"] })]);
  assert.equal(diffPlans(baseline, target).summary.modify, 0);
  assert.equal(diffPlans(baseline, target).summary.noChange, 1);
});

test("changes are ordered create, modify, destroy, then no-change", () => {
  const baseline = plan([res("keep"), res("gone"), res("edit", { sku: "A" })]);
  const target = plan([res("keep"), res("new"), res("edit", { sku: "B" })]);
  const actions = diffPlans(baseline, target).changes.map((c) => c.action);
  const rank = { create: 0, modify: 1, destroy: 2, "no-change": 3 } as const;
  const ranks = actions.map((a) => rank[a]);
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));
});

test("integration: a real plan diffed against itself is all no-change", () => {
  const here = fileURLToPath(new URL("../../examples/contoso-marketing", import.meta.url));
  const { plan: resolved } = resolveRepo(here, { now: () => new Date("2024-01-01T00:00:00.000Z") });

  const self = diffPlans(resolved, resolved);
  assert.equal(self.summary.create, 0);
  assert.equal(self.summary.modify, 0);
  assert.equal(self.summary.destroy, 0);
  assert.equal(self.summary.noChange, resolved.resources.length);

  const green = diffPlans(null, resolved);
  assert.equal(green.summary.create, resolved.resources.length);
  assert.equal(green.baseline, "greenfield");
});
