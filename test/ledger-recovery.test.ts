/**
 * Ledger recovery — an *unreadable* `.azx/deploy.json` (corrupt/truncated, or
 * written by a pre-hardening azx) must fail loud by default, but the operator can
 * recover by asserting explicit targeting flags rather than deleting the sole
 * record of live infra. Exercised end-to-end through the fully-offline `ship`
 * dry-run (no --create-repo ⇒ no git/gh/az calls).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function repoWithCorruptLedger(): string {
  const root = mkdtempSync(join(tmpdir(), "azx-recover-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "recover-me", dependencies: {} }));
  mkdirSync(join(root, ".azx"), { recursive: true });
  writeFileSync(join(root, ".azx", "deploy.json"), "{ this is not valid json");
  return root;
}

function runShip(root: string, extra: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, "ship", root, ...extra], { encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("an unreadable ledger fails loud when no explicit targeting is given", () => {
  const root = repoWithCorruptLedger();
  try {
    const { status, out } = runShip(root, []);
    assert.equal(status, 1, "must exit non-zero");
    assert.match(out, /not valid JSON|deploy ledger/i, "explains the unreadable ledger");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit --resource-group/--region recover from an unreadable ledger", () => {
  const root = repoWithCorruptLedger();
  const out = mkdtempSync(join(tmpdir(), "azx-recover-out-"));
  try {
    const res = runShip(root, ["--resource-group", "rg-recovered", "--region", "eastus2", "--out", out]);
    assert.equal(res.status, 0, `ship dry-run should succeed on recovery:\n${res.out}`);
    assert.match(res.out, /unreadable/i, "warns that the ledger was ignored");
    // The generated pipeline pins the operator's asserted targeting.
    const wf = readFileSync(join(out, ".github", "workflows", "deploy.yml"), "utf8");
    assert.match(wf, /RESOURCE_GROUP: "rg-recovered"/, "scaffold targets the override RG");
    assert.match(wf, /LOCATION: "eastus2"/, "scaffold targets the override region");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("recovery still validates the override against the safe charset", () => {
  const root = repoWithCorruptLedger();
  const out = mkdtempSync(join(tmpdir(), "azx-recover-bad-"));
  try {
    // A region display name is rejected even on the recovery path — we must never
    // generate an artifact azx couldn't later record in a ledger.
    const res = runShip(root, ["--resource-group", "rg-ok", "--region", "West US 2", "--out", out]);
    assert.equal(res.status, 1, "unsafe override is refused");
    assert.match(res.out, /region/i, "explains the region must be a short name");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
