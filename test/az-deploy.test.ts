/**
 * Local-deploy tests — the imperative inner loop + continuity ledger.
 *
 * `runLocalDeploy` is the only azx path that reaches real Azure, but it does so
 * exclusively through an injected {@link AzRunner}. Here we drive it with a fake
 * runner so every branch — auth gate, what-if gate, the real apply, the emitted
 * ledger, and error paths — is asserted fully offline. We also prove `ship`
 * adopts the ledger so the codified pipeline targets the same resource group.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { resolveRepo } from "../src/index.js";
import { runLocalDeploy, planNeedsPgPassword, type AzRunner } from "../src/az-deploy.js";
import { buildScaffold } from "../src/scaffold.js";

const FIXED = new Date("2024-01-01T00:00:00.000Z");

function build(name: string) {
  return resolveRepo(fileURLToPath(new URL(`../../examples/${name}`, import.meta.url)), {
    now: () => FIXED,
  });
}

/** A fake `az` that records calls and returns success (logged-in) by default. */
function fakeAz(overrides: Record<string, { status: number; stdout?: string; stderr?: string }> = {}) {
  const calls: string[][] = [];
  const runner: AzRunner = (args) => {
    calls.push(args);
    const key = args.slice(0, 3).join(" ");
    if (overrides[key]) {
      const o = overrides[key];
      return { status: o.status, stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
    }
    if (args[0] === "account" && args[1] === "show") {
      return { status: 0, stdout: JSON.stringify({ id: "sub-abc" }), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

const pgOpts = {
  bicepPath: "/tmp/main.bicep",
  resourceGroup: "rg-django-notes",
  region: "eastus2",
  pgPassword: "P@ssw0rd!",
};

test("planNeedsPgPassword detects the Postgres flexible server", () => {
  assert.equal(planNeedsPgPassword(build("django-notes").plan), true);
});

test("Postgres plan without a password is refused before any az call", () => {
  const { plan } = build("django-notes");
  const { runner, calls } = fakeAz();
  assert.throws(
    () => runLocalDeploy(plan, { ...pgOpts, pgPassword: undefined }, runner),
    /--pg-password/,
  );
  assert.equal(calls.length, 0, "must not call az when a required param is missing");
});

test("not logged in is a hard stop", () => {
  const { plan } = build("django-notes");
  const { runner } = fakeAz({ "account show -o": { status: 1, stderr: "Please run az login" } });
  assert.throws(() => runLocalDeploy(plan, pgOpts, runner), /az login/);
});

test("what-if failure refuses to deploy", () => {
  const { plan } = build("django-notes");
  const { runner, calls } = fakeAz({
    "deployment group what-if": { status: 1, stderr: "BCP error" },
  });
  assert.throws(() => runLocalDeploy(plan, { ...pgOpts, apply: true }, runner), /refusing to deploy/);
  // It attempted what-if but never reached create.
  assert.ok(!calls.some((c) => c[2] === "create"), "must not create after a failed what-if");
});

test("default (no apply) stops after the what-if gate — no create, no ledger", () => {
  const { plan } = build("django-notes");
  const { runner, calls } = fakeAz();
  const res = runLocalDeploy(plan, pgOpts, runner);
  assert.equal(res.applied, false);
  assert.equal(res.ledger, undefined);
  assert.ok(calls.some((c) => c[2] === "what-if"), "what-if must run");
  assert.ok(!calls.some((c) => c[2] === "create"), "create must NOT run without apply");
});

test("apply runs the real create and returns a continuity ledger", () => {
  const { plan } = build("django-notes");
  const { runner, calls } = fakeAz();
  const res = runLocalDeploy(plan, { ...pgOpts, apply: true, now: () => FIXED }, runner);

  assert.equal(res.applied, true);
  // Ordered az calls: account → group create → what-if → deployment create.
  const seq = calls.map((c) => c.slice(0, 3).join(" "));
  assert.deepEqual(seq, [
    "account show -o",
    "group create -n",
    "deployment group what-if",
    "deployment group create",
  ]);

  const led = res.ledger!;
  assert.equal(led.resourceGroup, "rg-django-notes");
  assert.equal(led.region, "eastus2");
  assert.equal(led.subscriptionId, "sub-abc");
  assert.equal(led.deploymentName, "azx-2024-01-01T00-00-00-000Z");
  assert.equal(led.resources.length, plan.resources.length);
  // The secret is passed as a parameter to both what-if and create.
  const createCall = calls.find((c) => c[2] === "create")!;
  assert.ok(createCall.includes("postgresAdminPassword=P@ssw0rd!"));
});

test("ship adopts the ledger: pipeline targets the same resource group", () => {
  const { intent, plan, bicep } = build("django-notes");
  const { runner } = fakeAz();
  const res = runLocalDeploy(plan, { ...pgOpts, apply: true, now: () => FIXED }, runner);

  const wf = buildScaffold(intent, plan, bicep, { ledger: res.ledger }).find(
    (f) => f.path === ".github/workflows/deploy.yml",
  )!.content;
  assert.ok(wf.includes("RESOURCE_GROUP: rg-django-notes"), "pipeline must reuse the ledger RG");

  const readme = buildScaffold(intent, plan, bicep, { ledger: res.ledger }).find(
    (f) => f.path === "README.md",
  )!.content;
  assert.ok(readme.includes("Adopting an existing local deploy"), "README should note adoption");
});
