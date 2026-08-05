/**
 * Deploy-ledger read/validate/persist. Absent is fine (greenfield); a present but
 * corrupt/incomplete ledger must FAIL LOUD rather than silently default targeting
 * and let us deploy into the wrong resource group or subscription.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadLedger, persistLedger, isDeployLedger } from "../src/ledger.js";
import type { DeployLedger } from "../src/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "azx-ledger-"));
}

function writeLedger(root: string, raw: string): void {
  mkdirSync(join(root, ".azx"), { recursive: true });
  writeFileSync(join(root, ".azx", "deploy.json"), raw);
}

const VALID: DeployLedger = {
  generatedBy: "azx",
  deployedAt: "2026-01-01T00:00:00Z",
  subscriptionId: "sub-123",
  resourceGroup: "rg-app",
  region: "swedencentral",
  deploymentName: "azx-1",
  resources: [],
};

test("absent ledger returns undefined (a normal greenfield, not an error)", () => {
  const root = tmpRoot();
  try {
    assert.equal(loadLedger(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("valid ledger round-trips through persist + load", () => {
  const root = tmpRoot();
  try {
    const p = persistLedger(root, VALID);
    assert.ok(p.endsWith(join(".azx", "deploy.json")));
    assert.deepEqual(loadLedger(root), VALID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed JSON fails loud (does not fall back to default targeting)", () => {
  const root = tmpRoot();
  try {
    writeLedger(root, "{ this is not valid json");
    assert.throws(() => loadLedger(root), /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("well-formed JSON missing required fields fails loud", () => {
  const root = tmpRoot();
  try {
    // Valid JSON, wrong shape (no resourceGroup/region/deploymentName).
    writeLedger(root, JSON.stringify({ generatedBy: "azx", resources: [] }));
    assert.throws(() => loadLedger(root), /missing required fields/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a truncated ledger (partial write) fails loud rather than parsing to garbage", () => {
  const root = tmpRoot();
  try {
    const full = JSON.stringify(VALID, null, 2);
    writeLedger(root, full.slice(0, Math.floor(full.length / 2))); // cut mid-object
    assert.throws(() => loadLedger(root), /not valid JSON|missing required fields/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isDeployLedger rejects non-objects and wrong-typed fields", () => {
  assert.equal(isDeployLedger(null), false);
  assert.equal(isDeployLedger("x"), false);
  assert.equal(isDeployLedger({ ...VALID, resourceGroup: "" }), false);
  assert.equal(isDeployLedger({ ...VALID, subscriptionId: 42 }), false);
  assert.equal(isDeployLedger({ ...VALID, resources: "nope" }), false);
  assert.equal(isDeployLedger(VALID), true);
  // subscriptionId is optional.
  const { subscriptionId, ...noSub } = VALID;
  assert.equal(isDeployLedger(noSub), true);
});

test("persistLedger leaves no temp file behind and overwrites atomically", () => {
  const root = tmpRoot();
  try {
    persistLedger(root, VALID);
    persistLedger(root, { ...VALID, deploymentName: "azx-2" });
    assert.equal(loadLedger(root)?.deploymentName, "azx-2");
    // The .tmp sibling must not survive a successful write.
    const entries = readdirSync(join(root, ".azx"));
    assert.deepEqual(entries, ["deploy.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
