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
      `deploy ledger ${p} is missing or has invalid required fields ` +
        `(generatedBy/resourceGroup/region/deploymentName/subscriptionId) — refusing to use it. ` +
        `Fix or delete it.`,
    );
  }
  return parsed;
}

/** Structural + format guard: the fields `ship`/`up` rely on for targeting must be
 * present AND safe. Format checks matter for security, not just correctness: RG,
 * region, subscriptionId, and deploymentName are baked verbatim into generated bash
 * (setup-azure-oidc.sh) and YAML (deploy.yml). A shape-valid but hostile ledger
 * (e.g. `subscriptionId: "$(rm -rf ~)"`, or a newline in `region`) travels inside an
 * untrusted app repo and would otherwise become shell/YAML injection at `ship` time.
 * We validate against the exact character sets azx itself emits, so real ledgers pass
 * and forged/exotic ones are rejected loud. */
export function isDeployLedger(v: unknown): v is DeployLedger {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  const nonEmptyStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  return (
    l.generatedBy === "azx" &&
    // Azure resource-group names: letters, digits, and . _ ( ) - only (no whitespace,
    // no shell metacharacters). Matches azx's slugified `rg-<name>`.
    nonEmptyStr(l.resourceGroup) &&
    /^[A-Za-z0-9._()-]+$/.test(l.resourceGroup) &&
    // Azure region short names are lowercase alphanumerics (e.g. `swedencentral`).
    nonEmptyStr(l.region) &&
    /^[a-z0-9]+$/.test(l.region) &&
    // ARM deployment name azx emits: `azx-<iso-with-dashes>`.
    nonEmptyStr(l.deploymentName) &&
    /^[A-Za-z0-9._-]+$/.test(l.deploymentName) &&
    // subscriptionId is optional, but when present it MUST be a real GUID — never an
    // empty string (which would pass a bare typeof check, win targeting precedence,
    // yet be falsy enough to skip `az account set` and silently hit the wrong account).
    (l.subscriptionId === undefined ||
      (nonEmptyStr(l.subscriptionId) &&
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          l.subscriptionId,
        ))) &&
    Array.isArray(l.resources) &&
    l.resources.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as Record<string, unknown>).id === "string" &&
        typeof (r as Record<string, unknown>).name === "string" &&
        typeof (r as Record<string, unknown>).type === "string",
    )
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
