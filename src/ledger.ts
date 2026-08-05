/**
 * Deploy-ledger persistence — the `.azx/deploy.json` continuity record written by
 * a local apply and adopted by `ship` / re-runs.
 *
 * Reading is deliberately strict: an *absent* ledger is a normal greenfield, but a
 * *present-but-invalid* one (unreadable, non-JSON, or missing required fields) FAILS
 * LOUD rather than silently defaulting targeting. A corrupt/truncated ledger must
 * never be allowed to bypass drift/partial checks and let us generate a fresh
 * deployment into the wrong resource group or subscription.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DeployLedger } from "./types.js";

/** Path of the ledger for a repo root. */
export function ledgerPath(root: string): string {
  return join(root, ".azx", "deploy.json");
}

/**
 * Load a local-deploy ledger from `<root>/.azx/deploy.json`. Returns `undefined`
 * when absent; throws a descriptive error when present but unreadable / invalid.
 */
export function loadLedger(root: string): DeployLedger | undefined {
  const p = ledgerPath(root);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; // absent = fine
    throw new Error(`could not read deploy ledger ${p}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `deploy ledger ${p} is not valid JSON — refusing to guess deploy targeting. Fix or delete it.`,
    );
  }
  if (!isDeployLedger(parsed)) {
    throw new Error(
      `deploy ledger ${p} is missing required fields ` +
        `(generatedBy/resourceGroup/region/deploymentName) — refusing to use it. Fix or delete it.`,
    );
  }
  return parsed;
}

/** Structural guard: the fields `ship`/`up` rely on for targeting must be present. */
export function isDeployLedger(v: unknown): v is DeployLedger {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  return (
    l.generatedBy === "azx" &&
    typeof l.resourceGroup === "string" &&
    l.resourceGroup.length > 0 &&
    typeof l.region === "string" &&
    l.region.length > 0 &&
    typeof l.deploymentName === "string" &&
    l.deploymentName.length > 0 &&
    (l.subscriptionId === undefined || typeof l.subscriptionId === "string") &&
    Array.isArray(l.resources)
  );
}

/** Write a ledger to `<root>/.azx/deploy.json` atomically, returning the path written. */
export function persistLedger(root: string, ledger: DeployLedger): string {
  const azxDir = join(root, ".azx");
  mkdirSync(azxDir, { recursive: true });
  const p = join(azxDir, "deploy.json");
  // Write to a sibling temp file then rename, so a crash mid-write can never leave a
  // half-written ledger that would later fail loud (or, worse, parse into garbage).
  const tmp = join(azxDir, `deploy.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(tmp, p);
  return p;
}
