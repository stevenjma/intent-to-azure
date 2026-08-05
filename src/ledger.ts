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

/**
 * Field-format contracts, exported so the *write* side (CLI flag validation,
 * `persistLedger`) and the *sink* side (`buildScaffold`) enforce exactly the same
 * character sets the *read* side does. Keeping one source of truth is what prevents
 * azx from writing a ledger it will later refuse to read.
 *
 * Anchored with `^…$`; JS `$` (no `m` flag) does NOT match before a trailing newline,
 * so these already reject embedded/trailing CR/LF — verified by test.
 */
/** Azure resource-group names: letters, digits, and `. _ ( ) -` only (matches azx's slugified `rg-<name>`). */
export const RESOURCE_GROUP_RE = /^[A-Za-z0-9._()-]+$/;
/** Azure region short names are lowercase alphanumerics (e.g. `swedencentral`). */
export const REGION_RE = /^[a-z0-9]+$/;
/** ARM deployment name azx emits: `azx-<iso-with-dashes>`. */
export const DEPLOYMENT_NAME_RE = /^[A-Za-z0-9._-]+$/;
/** A real subscription GUID — never a name/display string (which `az` also accepts). */
export const SUBSCRIPTION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** ISO-8601 UTC instant as produced by `Date.prototype.toISOString()`. */
export const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** ARM template hash: 64 lowercase hex chars. */
export const TEMPLATE_HASH_RE = /^[0-9a-f]{64}$/;

/** True when `x` is a non-empty string with no CR/LF (defence for values that reach
 * generated Markdown/YAML/bash but have no tighter charset). */
function safeText(x: unknown): x is string {
  return typeof x === "string" && x.length > 0 && !/[\r\n]/.test(x);
}

/** Structural + format guard: the fields `ship`/`up` rely on for targeting must be
 * present AND safe. Format checks matter for security, not just correctness: RG,
 * region, subscriptionId, and deploymentName are baked verbatim into generated bash
 * (setup-azure-oidc.sh) and YAML (deploy.yml), and `deployedAt`/`deploymentName` are
 * baked into the generated README that `ship --create-repo` commits and pushes. A
 * shape-valid but hostile ledger (e.g. `subscriptionId: "$(rm -rf ~)"`, a newline in
 * `region`, or Markdown/HTML smuggled through `deployedAt`) travels inside an
 * untrusted app repo and would otherwise become injection at generation time. We
 * validate against the exact shapes azx itself emits, so real ledgers pass and
 * forged/exotic ones are rejected loud. */
export function isDeployLedger(v: unknown): v is DeployLedger {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  const nonEmptyStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  return (
    l.generatedBy === "azx" &&
    nonEmptyStr(l.resourceGroup) &&
    RESOURCE_GROUP_RE.test(l.resourceGroup) &&
    nonEmptyStr(l.region) &&
    REGION_RE.test(l.region) &&
    nonEmptyStr(l.deploymentName) &&
    DEPLOYMENT_NAME_RE.test(l.deploymentName) &&
    // deployedAt reaches the generated README markdown — must be a clean ISO instant.
    nonEmptyStr(l.deployedAt) &&
    ISO_INSTANT_RE.test(l.deployedAt) &&
    // subscriptionId is optional, but when present it MUST be a real GUID — never an
    // empty string (which would pass a bare typeof check, win targeting precedence,
    // yet be falsy enough to skip `az account set` and silently hit the wrong account).
    (l.subscriptionId === undefined ||
      (nonEmptyStr(l.subscriptionId) && SUBSCRIPTION_ID_RE.test(l.subscriptionId))) &&
    // Optional metadata, but validated so a forged ledger can't smuggle values into
    // drift logic (templateHash) or the adoption note (partial).
    (l.partial === undefined || typeof l.partial === "boolean") &&
    (l.templateHash === undefined ||
      (nonEmptyStr(l.templateHash) && TEMPLATE_HASH_RE.test(l.templateHash))) &&
    Array.isArray(l.resources) &&
    l.resources.every((r) => {
      if (typeof r !== "object" || r === null) return false;
      const el = r as Record<string, unknown>;
      // id/name/type have no single Azure charset, but they must not carry CR/LF
      // that could break out of the generated Markdown/lines they may appear in.
      return safeText(el.id) && safeText(el.name) && safeText(el.type);
    })
  );
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
