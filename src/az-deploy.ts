/**
 * Stage [3] local deploy — the imperative "inner loop" that actually creates
 * Azure resources from a resolved plan, via the Azure CLI.
 *
 * This is the ONLY module in azx that reaches real Azure, and it does so purely
 * by shelling out to `az` through an injectable {@link AzRunner} — so the whole
 * thing is testable offline with a fake runner. The default runner requires you
 * to be logged in (`az login`); it never stores credentials.
 *
 * The flow is deliberately plan/apply-separated and what-if-gated:
 *   az account show           → fail fast unless logged in
 *   az group create           → ensure the target resource group
 *   az deployment group what-if → ALWAYS previewed (a safety gate)
 *   az deployment group create → only when {@link LocalDeployOptions.apply} is set
 *
 * On a successful apply it returns a {@link DeployLedger}, the continuity record
 * `azx ship` later adopts so the codified pipeline targets the same resources.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import type { AzurePlan, DeployLedger } from "./types.js";
import { SUBSCRIPTION_ID_RE } from "./ledger.js";

/** Result of one `az` invocation. */
export interface AzResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Thrown when a deploy fails. When the failure happened *after* resources may
 * have been created, {@link DeployError.ledger} carries a `partial` ledger so the
 * caller can persist it and the orphaned resource group can be reconciled.
 */
export class DeployError extends Error {
  readonly ledger?: DeployLedger;
  constructor(message: string, ledger?: DeployLedger) {
    super(message);
    this.name = "DeployError";
    this.ledger = ledger;
  }
}

/** Injectable `az` executor so this module is testable without a real cloud. */
export type AzRunner = (args: string[]) => AzResult;

export interface LocalDeployOptions {
  /** Absolute path to the `main.bicep` to deploy. */
  bicepPath: string;
  /** Target resource group (created if absent). */
  resourceGroup: string;
  /** Target region. */
  region: string;
  /** Optionally pin the subscription (`az account set`). */
  subscriptionId?: string;
  /** PostgreSQL admin password (required when the plan provisions Postgres). */
  pgPassword?: string;
  /** Actually create resources. When false (default) stops after what-if. */
  apply?: boolean;
  /** Injectable clock for deterministic deployment names / ledger timestamps. */
  now?: () => Date;
}

export interface LocalDeployResult {
  /** Whether real resources were created (vs. what-if only). */
  applied: boolean;
  /** Whether a budget guardrail blocked the deploy (caller pre-checks). */
  blocked: boolean;
  /** Human-readable, ordered account of every step taken. */
  steps: string[];
  /** Captured `what-if` output. */
  whatIf?: string;
  /** The continuity ledger — present only after a successful apply. */
  ledger?: DeployLedger;
}

/** True when the plan provisions a PostgreSQL flexible server (needs a password). */
export function planNeedsPgPassword(plan: AzurePlan): boolean {
  return plan.resources.some((r) => r.type === "Microsoft.DBforPostgreSQL/flexibleServers");
}

/**
 * Quote one argument for cmd.exe: wrap in double quotes and double any embedded
 * quote. Inside double quotes cmd.exe treats space and the metacharacters
 * `& | < > ^ ( )` as literal, so this is the safe way to pass a path that may
 * contain spaces (e.g. a `%TEMP%` under `C:\Users\First Last\...`) or an arg with
 * a metacharacter without word-splitting or command injection. We never rely on
 * Node's `shell:true` arg joining, which sets windowsVerbatimArguments (no quoting).
 */
export function winQuoteArg(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Default runner: invoke the real `az` CLI, capturing output. */
export function defaultAzRunner(): AzRunner {
  // On Windows the Azure CLI is a batch shim (`az.cmd`); recent Node refuses to
  // spawn `.cmd`/`.bat` without a shell (EINVAL), so we must go through cmd.exe.
  // But shell:true with an args ARRAY sets windowsVerbatimArguments and Node does
  // NOT quote — a temp path with a space or a metachar in an arg would break the
  // command or inject. Build one explicitly quoted command line instead. On POSIX
  // we spawn `az` directly (shell:false) to avoid quoting surprises entirely.
  const isWin = process.platform === "win32";
  return (args) => {
    const res = isWin
      ? spawnSync(["az", ...args].map(winQuoteArg).join(" "), { encoding: "utf8", shell: true })
      : spawnSync("az", args, { encoding: "utf8", shell: false });
    if (res.error) {
      const e = res.error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error("Azure CLI not found on PATH. Install `az` and run `az login`.");
      }
      throw res.error;
    }
    return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  };
}

/**
 * Parameter args shared by what-if and create. The Postgres admin password is a
 * `@secure()` param and is NEVER placed on the command line (argv is world-readable
 * via `ps`/`/proc/<pid>/cmdline`). Instead the caller writes it to a 0600 params
 * file and we reference it with `--parameters @<file>`.
 */
function paramArgs(opts: LocalDeployOptions, paramsFile?: string): string[] {
  const args = ["--template-file", opts.bicepPath];
  if (paramsFile) args.push("--parameters", `@${paramsFile}`);
  return args;
}

/** SHA-256 of the bicep being deployed, best-effort (undefined if unreadable). */
function templateHash(bicepPath: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(bicepPath)).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Run an imperative local deploy of `plan`/`bicep` via the Azure CLI. Pure
 * except for the injected {@link AzRunner}; the CLI passes the real one, tests
 * pass a fake. Throws on any hard failure (not logged in, what-if error, missing
 * PG password) so the caller never applies a broken template.
 */
export function runLocalDeploy(
  plan: AzurePlan,
  opts: LocalDeployOptions,
  runner: AzRunner = defaultAzRunner(),
): LocalDeployResult {
  const steps: string[] = [];
  const needsPg = planNeedsPgPassword(plan);

  if (needsPg && !opts.pgPassword) {
    throw new Error(
      "this plan provisions PostgreSQL — pass --pg-password <value> (it is a @secure() param with no default).",
    );
  }

  // The Postgres admin password never goes on argv. Write it to a locked-down
  // (0600) params file next to the bicep and reference it with `--parameters @`.
  // Cleaned up in the `finally` below so the secret never lingers on disk.
  let paramsFile: string | undefined;
  if (needsPg && opts.pgPassword) {
    paramsFile = join(dirname(opts.bicepPath), "azx.params.json");
    writeFileSync(
      paramsFile,
      JSON.stringify({ postgresAdminPassword: { value: opts.pgPassword } }) + "\n",
      { mode: 0o600 },
    );
  }

  try {
    // 1. Must be logged in.
    const account = runner(["account", "show", "-o", "json"]);
    if (account.status !== 0) {
      throw new Error("not logged in to Azure. Run `az login` first.");
    }
    let subscriptionId: string | undefined = opts.subscriptionId;
    try {
      const parsed = JSON.parse(account.stdout) as { id?: string };
      subscriptionId = subscriptionId ?? parsed.id;
    } catch {
      /* leave subscriptionId as provided */
    }
    steps.push(`authenticated to Azure${subscriptionId ? ` (subscription ${subscriptionId})` : ""}`);

    // 2. Pin subscription if asked.
    if (opts.subscriptionId) {
      const set = runner(["account", "set", "--subscription", opts.subscriptionId]);
      if (set.status !== 0) throw new Error(`az account set failed: ${set.stderr.trim()}`);
      // `az account set` accepts a subscription NAME as well as a GUID. Re-query the
      // canonical id so the ledger always records a GUID — otherwise a name like
      // "Contoso Dev" would be persisted and then rejected by loadLedger on the next
      // `ship`/re-run, stranding a live deploy behind an unreadable continuity record.
      const canonical = runner(["account", "show", "--query", "id", "-o", "tsv"]);
      if (canonical.status === 0) {
        const id = canonical.stdout.trim();
        if (id) subscriptionId = id;
      }
      steps.push(`selected subscription ${subscriptionId ?? opts.subscriptionId}`);
    }

    // 2b. Canonicalization gate — FAIL BEFORE creating any resource. `az account set`
    // and `account show -o json` can leave `subscriptionId` as a display name (if the
    // re-query above failed open) or an otherwise non-GUID value. If we proceeded, the
    // apply would succeed but `persistLedger` would then reject the non-canonical id
    // AFTER resources are live — stranding a billable deploy behind an unwritable
    // ledger. Throwing here (before `az group create`) means no resources exist yet.
    // Require a canonical GUID UNCONDITIONALLY before any resource is created. A
    // non-GUID value (display name left over from `az account set`) OR an `undefined`
    // one (malformed `az account show` JSON, or output missing `id`) must both stop
    // us here: proceeding would apply against whatever account is current and then
    // `persistLedger` would reject the id AFTER resources are live — stranding a
    // billable deploy behind an unwritable ledger. Throwing before `az group create`
    // means no resources exist yet.
    if (subscriptionId === undefined || !SUBSCRIPTION_ID_RE.test(subscriptionId)) {
      throw new Error(
        `could not resolve the active Azure subscription to a canonical GUID ` +
          `(az returned ${JSON.stringify(subscriptionId)}). Refusing to deploy with a subscription ` +
          `azx can't record in its deploy ledger — run \`az account set\` or pass --subscription-id <guid>.`,
      );
    }

    // 3. Ensure the resource group.
    const rg = runner(["group", "create", "-n", opts.resourceGroup, "-l", opts.region, "-o", "none"]);
    if (rg.status !== 0) throw new Error(`az group create failed: ${rg.stderr.trim()}`);
    steps.push(`ensured resource group ${opts.resourceGroup} in ${opts.region}`);

    // 4. What-if gate — always previewed, never optional.
    const params = paramArgs(opts, paramsFile);
    const whatIf = runner([
      "deployment",
      "group",
      "what-if",
      "-g",
      opts.resourceGroup,
      ...params,
      "--no-pretty-print",
    ]);
    if (whatIf.status !== 0) {
      throw new Error(`what-if failed (refusing to deploy): ${whatIf.stderr.trim() || whatIf.stdout.trim()}`);
    }
    steps.push("what-if preview succeeded");

    // 5. Stop here unless applying.
    if (!opts.apply) {
      steps.push("stopped after what-if (pass --yes to apply)");
      return { applied: false, blocked: false, steps, whatIf: whatIf.stdout };
    }

    // 6. Real deploy.
    const now = (opts.now ?? (() => new Date()))();
    const deploymentName = `azx-${now.toISOString().replace(/[:.]/g, "-")}`;
    const ledgerBase: DeployLedger = {
      generatedBy: "azx",
      deployedAt: now.toISOString(),
      subscriptionId,
      resourceGroup: opts.resourceGroup,
      region: opts.region,
      deploymentName,
      templateHash: templateHash(opts.bicepPath),
      resources: plan.resources.map((r) => ({ id: r.id, name: r.name, type: r.type })),
    };

    const create = runner([
      "deployment",
      "group",
      "create",
      "-g",
      opts.resourceGroup,
      "--name",
      deploymentName,
      ...params,
      "-o",
      "none",
    ]);
    if (create.status !== 0) {
      // ARM deployments are not atomic: some resources may already be live. Emit a
      // `partial` ledger so the orphaned RG can be reconciled or torn down.
      throw new DeployError(
        `deployment failed: ${create.stderr.trim() || create.stdout.trim()}`,
        { ...ledgerBase, partial: true },
      );
    }
    steps.push(`deployed ${plan.resources.length} resource(s) as ${deploymentName}`);

    return { applied: true, blocked: false, steps, whatIf: whatIf.stdout, ledger: ledgerBase };
  } finally {
    if (paramsFile) {
      try {
        rmSync(paramsFile, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
