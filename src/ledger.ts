/**
 * Deploy-ledger persistence — the `.azx/deploy.json` continuity record written by
 * a local apply and adopted by `ship` / re-runs.
 *
 * Reading is deliberately strict: an *absent* ledger is a normal greenfield, but a
 * *present-but-invalid* one (unreadable, non-JSON, or missing required fields) FAILS
 * LOUD rather than silently defaulting targeting. A corrupt/truncated ledger must
 * never be allowed to bypass drift/partial checks and let us generate a fresh
 * deployment into the wrong resource group or subscription.
 *
 * All the pure validation (field regexes + `isDeployLedger`) lives in the
 * browser-safe `ledger-core`; this file only adds the filesystem read/write sinks
 * and re-exports the core surface for existing importers.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DeployLedger } from "./types.js";
import { isDeployLedger } from "./ledger-core.js";

export {
  RESOURCE_GROUP_RE,
  REGION_RE,
  DEPLOYMENT_NAME_RE,
  SUBSCRIPTION_ID_RE,
  ISO_INSTANT_RE,
  TEMPLATE_HASH_RE,
  isDeployLedger,
} from "./ledger-core.js";

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
      `deploy ledger ${p} is missing or has invalid required fields ` +
        `(generatedBy/resourceGroup/region/deploymentName/subscriptionId) — refusing to use it. ` +
        `Fix or delete it.`,
    );
  }
  return parsed;
}

/** Write a ledger to `<root>/.azx/deploy.json` atomically, returning the path written.
 * Asserts the ledger is valid FIRST: azx must never persist a record its own reader
 * would later reject (which would strand a live, billable deploy with an unreadable
 * continuity record). A caller that hits this is passing un-canonicalized input and
 * should fix targeting before deploying, not after. */
export function persistLedger(root: string, ledger: DeployLedger): string {
  if (!isDeployLedger(ledger)) {
    throw new Error(
      "refusing to persist an invalid deploy ledger — targeting fields must be " +
        "canonical (GUID subscription, slug region, safe resource-group/deployment name). " +
        "This is an azx bug or an un-normalized override; fix targeting before deploying.",
    );
  }
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