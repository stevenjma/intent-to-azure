/**
 * Ledger recovery — an *unreadable* `.azx/deploy.json` (corrupt/truncated, or
 * written by a pre-hardening azx) must fail loud by default. The operator can
 * recover, but ONLY by asserting the COMPLETE live target
 * (--resource-group + --region + --subscription-id) so no field silently defaults
 * to the wrong RG / current `az` account. Exercised end-to-end through the
 * fully-offline `ship` dry-run (no --create-repo ⇒ no git/gh/az calls).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SUB = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

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

test("PARTIAL targeting is refused — recovery demands the complete tuple", () => {
  const root = repoWithCorruptLedger();
  const out = mkdtempSync(join(tmpdir(), "azx-recover-partial-"));
  try {
    // RG + region but NO subscription: the un-asserted subscription would otherwise
    // silently fall back to whatever `az` account is current.
    const res = runShip(root, ["--resource-group", "rg-x", "--region", "eastus2", "--out", out]);
    assert.equal(res.status, 1, "partial recovery must fail");
    assert.match(res.out, /--subscription-id/, "names the missing field");
    assert.match(res.out, /complete/i, "explains the full target is required");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("the COMPLETE tuple recovers and pins RG / region / subscription into the pipeline", () => {
  const root = repoWithCorruptLedger();
  const out = mkdtempSync(join(tmpdir(), "azx-recover-out-"));
  try {
    const res = runShip(root, [
      "--resource-group", "rg-recovered",
      "--region", "eastus2",
      "--subscription-id", SUB,
      "--out", out,
    ]);
    assert.equal(res.status, 0, `ship dry-run should succeed on recovery:\n${res.out}`);
    assert.match(res.out, /unreadable/i, "warns that the ledger was ignored");
    const wf = readFileSync(join(out, ".github", "workflows", "deploy.yml"), "utf8");
    assert.match(wf, /RESOURCE_GROUP: "rg-recovered"/, "scaffold targets the override RG");
    assert.match(wf, /LOCATION: "eastus2"/, "scaffold targets the override region");
    // The operator's asserted subscription must reach the generated OIDC setup script,
    // NOT be dropped so the script falls back to `az account show`.
    const setup = readFileSync(join(out, "scripts", "setup-azure-oidc.sh"), "utf8");
    assert.match(setup, new RegExp(`DEFAULT_SUBSCRIPTION="${SUB}"`), "pins the asserted subscription");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("recovery still validates the region override against the safe charset", () => {
  const root = repoWithCorruptLedger();
  const out = mkdtempSync(join(tmpdir(), "azx-recover-bad-"));
  try {
    // A full tuple is supplied (so we pass the completeness gate), but the region is a
    // display name — buildScaffold must still refuse to generate.
    const res = runShip(root, [
      "--resource-group", "rg-ok",
      "--region", "West US 2",
      "--subscription-id", SUB,
      "--out", out,
    ]);
    assert.equal(res.status, 1, "unsafe region is refused even on recovery");
    assert.match(res.out, /region/i, "explains the region must be a short name");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("recovery still validates the subscription override against the safe charset", () => {
  const root = repoWithCorruptLedger();
  const out = mkdtempSync(join(tmpdir(), "azx-recover-badsub-"));
  try {
    const res = runShip(root, [
      "--resource-group", "rg-ok",
      "--region", "eastus2",
      "--subscription-id", "Contoso Dev",
      "--out", out,
    ]);
    assert.equal(res.status, 1, "a non-GUID subscription is refused on recovery");
    assert.match(res.out, /subscription/i, "explains the subscription must be a GUID");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
