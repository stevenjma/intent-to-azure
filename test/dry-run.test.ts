/**
 * Safety guard (FIX 5): POC #1 must stay a dry run. The only deployer is the
 * print-only stub, and the stage-3 `up` path (`dryRun` / `DryRunDeployer`)
 * returns a dry-run marker + would-be steps while performing no real work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { resolveRepo, dryRun, DryRunDeployer } from "../src/index.js";
import * as run from "../src/run.js";
import * as index from "../src/index.js";

function fixture(name: string) {
  const root = fileURLToPath(new URL(`../../examples/${name}`, import.meta.url));
  return resolveRepo(root, { now: () => new Date("2024-01-01T00:00:00.000Z") });
}

test("dryRun() returns the print-only stub, never a real deploy", () => {
  const { plan, bicep } = fixture("contoso-marketing");
  const result = dryRun(plan, bicep);

  assert.equal(result.dryRun, true, "result must be flagged as a dry run");
  assert.equal(plan.meta.dryRun, true, "plan meta must be flagged as a dry run");
  assert.ok(Array.isArray(result.steps) && result.steps.length > 0, "expected would-be steps");
  // The very first step is the dry-run marker; nothing here deploys.
  assert.match(result.steps[0] ?? "", /DRY RUN \(no Azure calls made\)/);
  assert.ok(
    result.steps.some((s) => /would deploy/.test(s)),
    "steps should describe what *would* happen",
  );
  assert.ok(
    result.steps.some((s) => /STUB: real deployment is out of scope/.test(s)),
    "steps must state real deployment is out of scope",
  );
});

test("DryRunDeployer is a dry run and matches the free dryRun()", async () => {
  const { plan, bicep } = fixture("contoso-marketing");
  const viaClass = await new DryRunDeployer().run(plan, bicep);
  assert.equal(viaClass.dryRun, true);
  assert.deepEqual(viaClass, dryRun(plan, bicep));
});

test("no non-dry deployer is exported", () => {
  // Any exported symbol whose name looks like a deployer must be the dry-run one.
  for (const mod of [run as Record<string, unknown>, index as Record<string, unknown>]) {
    for (const [name, value] of Object.entries(mod)) {
      if (/deployer/i.test(name)) {
        assert.equal(value, DryRunDeployer, `unexpected deployer export: ${name}`);
      }
    }
  }
});
