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

import type { AzurePlan, DeployLedger } from "./types.js";

/** Result of one `az` invocation. */
export interface AzResult {
  status: number;
  stdout: string;
  stderr: string;
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

/** Default runner: invoke the real `az` CLI, capturing output. */
export function defaultAzRunner(): AzRunner {
  // On Windows the Azure CLI is a batch shim (`az.cmd`); recent Node refuses to
  // spawn `.cmd`/`.bat` without a shell (EINVAL), so use shell:true there. On
  // POSIX we spawn `az` directly (shell:false) to avoid quoting surprises.
  const isWin = process.platform === "win32";
  return (args) => {
    const res = isWin
      ? spawnSync("az", args, { encoding: "utf8", shell: true })
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

/** Parameter args shared by what-if and create when the plan needs a PG password. */
function paramArgs(opts: LocalDeployOptions, needsPg: boolean): string[] {
  const args = ["--template-file", opts.bicepPath];
  if (needsPg && opts.pgPassword) {
    args.push("--parameters", `postgresAdminPassword=${opts.pgPassword}`);
  }
  return args;
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
    steps.push(`selected subscription ${opts.subscriptionId}`);
  }

  // 3. Ensure the resource group.
  const rg = runner(["group", "create", "-n", opts.resourceGroup, "-l", opts.region, "-o", "none"]);
  if (rg.status !== 0) throw new Error(`az group create failed: ${rg.stderr.trim()}`);
  steps.push(`ensured resource group ${opts.resourceGroup} in ${opts.region}`);

  // 4. What-if gate — always previewed, never optional.
  const params = paramArgs(opts, needsPg);
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
    throw new Error(`deployment failed: ${create.stderr.trim() || create.stdout.trim()}`);
  }
  steps.push(`deployed ${plan.resources.length} resource(s) as ${deploymentName}`);

  const ledger: DeployLedger = {
    generatedBy: "azx",
    deployedAt: now.toISOString(),
    subscriptionId,
    resourceGroup: opts.resourceGroup,
    region: opts.region,
    deploymentName,
    resources: plan.resources.map((r) => ({ id: r.id, name: r.name, type: r.type })),
  };

  return { applied: true, blocked: false, steps, whatIf: whatIf.stdout, ledger };
}
