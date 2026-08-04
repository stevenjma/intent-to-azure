#!/usr/bin/env node
/**
 * azx CLI — the primary surface of the App Intent Service (POC #1).
 *
 * Commands (all dry-run, no Azure calls):
 *   azx plan  <path>   stages 0→2: signals table, App Intent JSON, Azure plan + Bicep, confirms
 *   azx scan  <path>   stage 0 only: detected app + signals table
 *   azx bicep <path>   print (or --out) just the generated main.bicep
 *   azx what-if <path> offline plan diff vs a prior plan (--against) + approval gate
 *   azx up    <path>   stage 3 STUB: prints what *would* deploy — never deploys
 *   azx schema         print the app-intent.schema.json (open contract)
 *   azx help
 *
 * Flags: --json  --guardrails <file>  --subscription <file>  --out <file>
 *        --no-bicep  --no-color  --against <plan.json>  --yes
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, readSync, mkdirSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { readRepo, type RepoScan } from "./read-repo.js";
import { extractIntent } from "./extract-intent.js";
import { loadGuardrails, parseGuardrails } from "./guardrails.js";
import { loadBudget, normalizeBudget } from "./budget.js";
import { plan as planIntent } from "./plan.js";
import { generateBicep } from "./bicep.js";
import { dryRun } from "./run.js";
import { diffPlans } from "./diff.js";
import { buildScaffold, resourceGroupFor, type ScaffoldFile } from "./scaffold.js";
import { shipSteps, runShip, writeScaffoldFiles, type ShipStep } from "./ship.js";
import { runLocalDeploy, DeployError } from "./az-deploy.js";
import type { AppIntent, AzurePlan, ChangeAction, Confirmation, Guardrails, BudgetContext, Confidence, PlanDiff, DeployLedger } from "./types.js";

interface Values {
  json?: boolean;
  guardrails?: string;
  subscription?: string;
  out?: string;
  scaffold?: string;
  "create-repo"?: string;
  deploy?: boolean;
  private?: boolean;
  "local-deploy"?: boolean;
  "resource-group"?: string;
  region?: string;
  "pg-password"?: string;
  "subscription-id"?: string;
  against?: string;
  yes?: boolean;
  "no-bicep"?: boolean;
  "no-color"?: boolean;
  help?: boolean;
  version?: boolean;
}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        guardrails: { type: "string" },
        subscription: { type: "string" },
        out: { type: "string" },
        scaffold: { type: "string" },
        "create-repo": { type: "string" },
        deploy: { type: "boolean" },
        private: { type: "boolean" },
        "local-deploy": { type: "boolean" },
        "resource-group": { type: "string" },
        region: { type: "string" },
        "pg-password": { type: "string" },
        "subscription-id": { type: "string" },
        against: { type: "string" },
        yes: { type: "boolean" },
        "no-bicep": { type: "boolean" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (err) {
    process.stderr.write(`azx: ${(err as Error).message}\n`);
    printUsage();
    return 2;
  }

  const values = parsed.values as Values;
  const positionals = parsed.positionals;
  const color = makeColor(!values["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY);

  if (values.version) {
    process.stdout.write(readVersion() + "\n");
    return 0;
  }

  const command = positionals[0] ?? "help";
  const repoArg = positionals[1] ?? ".";

  if (values.help || command === "help") {
    printUsage();
    return 0;
  }

  try {
    switch (command) {
      case "scan":
        return cmdScan(repoArg, values, color);
      case "plan":
        return cmdPlan(repoArg, values, color);
      case "bicep":
        return cmdBicep(repoArg, values, color);
      case "what-if":
      case "whatif":
        return cmdWhatIf(repoArg, values, color);
      case "up":
        return cmdUp(repoArg, values, color);
      case "ship":
        return cmdShip(repoArg, values, color);
      case "schema":
        return cmdSchema(values);
      default:
        process.stderr.write(`azx: unknown command '${command}'\n`);
        printUsage();
        return 2;
    }
  } catch (err) {
    process.stderr.write(`azx: ${(err as Error).message}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Pipeline assembly (offline)
// ---------------------------------------------------------------------------

function loadInputs(root: string, values: Values): { guardrails?: Guardrails; budget?: BudgetContext } {
  const guardrails = values.guardrails
    ? parseGuardrails(readFileSync(resolve(values.guardrails), "utf8"))
    : loadGuardrails(root);
  let budget: BudgetContext | undefined;
  if (values.subscription) {
    const raw = JSON.parse(readFileSync(resolve(values.subscription), "utf8"));
    budget = normalizeBudget(raw as Record<string, unknown>);
  } else {
    budget = loadBudget(root);
  }
  return { guardrails, budget };
}

function buildAll(root: string, values: Values): { scan: RepoScan; intent: AppIntent; plan: AzurePlan; bicep: string } {
  const scan = readRepo(root);
  const { guardrails, budget } = loadInputs(root, values);
  const intent = extractIntent(scan, { guardrails, budget });
  const resolved = planIntent(intent, { guardrails, budget });
  const bicep = generateBicep(resolved);
  return { scan, intent, plan: resolved, bicep };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdScan(repoArg: string, values: Values, c: Color): number {
  const root = resolve(repoArg);
  const scan = readRepo(root);
  if (values.json) {
    process.stdout.write(JSON.stringify(scan, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(banner(c, `scan ${basename(root)}`));
  process.stdout.write(renderApp(scan, c));
  process.stdout.write("\n" + renderSignals(scan.signals, new Map(), c));
  return 0;
}

function cmdPlan(repoArg: string, values: Values, c: Color): number {
  const root = resolve(repoArg);
  const { scan, intent, plan, bicep } = buildAll(root, values);

  if (values.out) writeFileSync(resolve(values.out), bicep);

  // --scaffold writes the ENTIRE deployable repo tree (Bicep + CI/CD pipeline)
  // to disk as inert code — the "all the code, not tied to a live repo" mode.
  let scaffoldFiles: ScaffoldFile[] | undefined;
  if (values.scaffold) {
    scaffoldFiles = buildScaffold(intent, plan, bicep, { ledger: loadLedger(root) });
    writeScaffoldFiles(resolve(values.scaffold), scaffoldFiles);
  }

  if (values.json) {
    const payload: Record<string, unknown> = { intent, plan, bicep };
    if (scaffoldFiles) payload.scaffold = scaffoldFiles;
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return 0;
  }

  const conf = confidenceByCapability(intent);
  process.stdout.write(banner(c, `plan ${intent.app.name}  ${c.dim("(dry-run · no Azure calls)")}`));
  process.stdout.write(renderApp(scan, c));
  process.stdout.write("\n" + c.bold("Signals\n") + renderSignals(scan.signals, conf, c));
  process.stdout.write("\n" + c.bold("App Intent  ") + c.dim("(POST /v1/intent request)\n"));
  process.stdout.write(renderIntentJson(intent) + "\n");
  process.stdout.write("\n" + c.bold("Azure Plan\n") + renderPlan(plan, c));
  process.stdout.write(renderConfirmations(plan.confirmations, c));
  if (!values["no-bicep"]) {
    process.stdout.write("\n" + c.bold("main.bicep\n"));
    process.stdout.write(c.dim(hr()) + "\n" + bicep + c.dim(hr()) + "\n");
  }
  if (values.out) process.stdout.write(c.dim(`\nBicep written to ${resolve(values.out)}\n`));
  if (scaffoldFiles) {
    process.stdout.write(
      c.dim(`\nScaffold (${scaffoldFiles.length} files) written to ${resolve(values.scaffold!)}\n`),
    );
    process.stdout.write(
      c.dim(`  Ship it live with: azx ship ${basename(root)} --create-repo <owner/name>\n`),
    );
  }
  return 0;
}

function cmdBicep(repoArg: string, values: Values, _c: Color): number {
  const root = resolve(repoArg);
  const { bicep } = buildAll(root, values);
  if (values.out) {
    writeFileSync(resolve(values.out), bicep);
    process.stdout.write(`Bicep written to ${resolve(values.out)}\n`);
  } else {
    process.stdout.write(bicep);
  }
  return 0;
}

/**
 * `azx what-if <path> [--against prev.json] [--yes] [--json]`
 *
 * Offline plan diff + approval gate. With no --against this is an honest
 * greenfield preview (everything is a `create`); with --against it diffs the
 * freshly resolved plan against a previously-saved azx plan. Never calls Azure —
 * approval simply hands off to the same `up` dry-run stub.
 */
function cmdWhatIf(repoArg: string, values: Values, c: Color): number {
  const root = resolve(repoArg);
  const { plan, bicep } = buildAll(root, values);

  const baseline = values.against ? loadBaselinePlan(values.against) : null;
  const diff = diffPlans(baseline, plan);
  const blocked = plan.budget.blocked;

  if (values.json) {
    const approved = !!values.yes && !blocked;
    const decision = {
      approved,
      reason: blocked
        ? "blocked by budget guardrail"
        : approved
          ? "auto-approved via --yes"
          : "not approved (pass --yes to approve)",
    };
    process.stdout.write(JSON.stringify({ plan, diff, decision }, null, 2) + "\n");
    return blocked ? 1 : 0;
  }

  process.stdout.write(
    banner(c, `what-if ${basename(root)}  ${c.dim("(offline plan diff · no Azure calls)")}`),
  );
  process.stdout.write(renderDiff(diff, c));

  // Budget guardrail is a hard stop: report and refuse without prompting.
  if (blocked) {
    process.stdout.write("\n" + c.red("✗ Blocked by budget guardrail — not approvable.") + "\n");
    for (const w of plan.budget.warnings) process.stdout.write("  " + c.yellow("⚠ " + w) + "\n");
    return 1;
  }

  const decision = decideApproval(values);
  if (!decision.approved) {
    process.stdout.write("\n" + c.dim(decision.reason) + "\n");
    return 0;
  }

  process.stdout.write(
    "\n" + c.bold("Approved.") + c.dim(" Handing off to dry-run (still no Azure calls)…") + "\n",
  );
  const result = dryRun(plan, bicep);
  for (const step of result.steps) {
    const line = step.startsWith("  ") ? c.dim(step) : step;
    process.stdout.write(line + "\n");
  }
  return result.blocked ? 1 : 0;
}

/** Load a baseline plan from --against; accepts a raw AzurePlan or `azx plan --json`. */
function loadBaselinePlan(file: string): AzurePlan {
  const raw = JSON.parse(readFileSync(resolve(file), "utf8")) as unknown;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.resources)) return raw as AzurePlan;
    const nested = obj.plan as Record<string, unknown> | undefined;
    if (nested && Array.isArray(nested.resources)) return nested as unknown as AzurePlan;
  }
  throw new Error(
    `--against file '${file}' is not an azx plan (expected .resources or .plan.resources)`,
  );
}

/**
 * Resolve the approval decision without ever hanging in automation.
 * --yes auto-approves; a real TTY on both stdin+stdout gets an interactive
 * prompt; anything else (pipes, CI, --json handled earlier) declines cleanly.
 */
function decideApproval(values: Values): { approved: boolean; reason: string } {
  if (values.yes) return { approved: true, reason: "auto-approved via --yes" };
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return promptYesNo("Apply this plan? [y/N] ")
      ? { approved: true, reason: "approved interactively" }
      : { approved: false, reason: "Not approved." };
  }
  return {
    approved: false,
    reason: "Not approved (non-interactive; pass --yes to approve).",
  };
}

/** Synchronous [y/N] prompt read from fd 0. Only reached on a real TTY. */
function promptYesNo(prompt: string): boolean {
  process.stdout.write(prompt);
  const buf = Buffer.alloc(256);
  let input = "";
  try {
    while (!input.includes("\n")) {
      let bytes = 0;
      try {
        bytes = readSync(0, buf, 0, buf.length, null);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") continue;
        return false;
      }
      if (bytes === 0) break;
      input += buf.toString("utf8", 0, bytes);
    }
  } catch {
    return false;
  }
  const answer = input.trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function cmdUp(repoArg: string, values: Values, c: Color): number {
  const root = resolve(repoArg);
  const { intent, plan, bicep } = buildAll(root, values);

  // --local-deploy: the imperative "inner loop" — really create Azure resources
  // via `az` (what-if gated). Everything else stays the offline dry-run stub.
  if (values["local-deploy"]) {
    return cmdLocalDeploy(root, intent, plan, bicep, values, c);
  }

  const result = dryRun(plan, bicep);
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(banner(c, `up ${basename(root)}  ${c.dim("(dry-run stub)")}`));
  for (const step of result.steps) {
    const line = step.startsWith("  ") ? c.dim(step) : step;
    process.stdout.write(line + "\n");
  }
  process.stdout.write(
    c.dim("\nTip: `azx up <path> --local-deploy` really deploys to Azure (needs `az login`).\n"),
  );
  return result.blocked ? 1 : 0;
}

/**
 * `azx up <path> --local-deploy [--yes] [--resource-group r] [--region x]
 *                               [--pg-password p] [--subscription-id id]`
 *
 * The imperative inner loop: `az` really creates the resources. What-if is always
 * previewed first; the real apply only happens with --yes. On success it writes
 * `.azx/deploy.json` — the continuity ledger `azx ship` adopts to codify this
 * same deployment into a reviewed CI/CD pipeline.
 */
function cmdLocalDeploy(
  root: string,
  intent: AppIntent,
  plan: AzurePlan,
  bicep: string,
  values: Values,
  c: Color,
): number {
  if (plan.budget.blocked) {
    process.stdout.write(banner(c, `deploy ${intent.app.name}`));
    process.stdout.write(c.red("\n✗ Blocked by budget guardrail — refusing to deploy.\n"));
    for (const w of plan.budget.warnings) process.stdout.write("  " + c.yellow("⚠ " + w) + "\n");
    return 1;
  }

  const ledger = loadLedger(root);
  const rg = values["resource-group"] ?? resourceGroupFor(intent, { ledger });
  const region = values.region ?? ledger?.region ?? plan.region;
  const apply = !!values.yes;

  // The `az deployment` calls need main.bicep on disk. Write it to a throwaway
  // temp dir so we never pollute the user's repo; only the ledger lands in .azx/.
  const bicepPath = join(mkdtempSync(join(tmpdir(), "azx-deploy-")), "main.bicep");
  writeFileSync(bicepPath, bicep);

  let result;
  try {
    result = runLocalDeploy(plan, {
      bicepPath,
      resourceGroup: rg,
      region,
      subscriptionId: values["subscription-id"],
      pgPassword: values["pg-password"],
      apply,
    });
  } catch (err) {
    // A partial failure still created a real (billable) resource group — persist
    // its ledger so `ship` and the user can reconcile or tear it down.
    let partialPath: string | undefined;
    if (err instanceof DeployError && err.ledger) {
      partialPath = persistLedger(root, err.ledger);
    }
    if (values.json) {
      process.stdout.write(
        JSON.stringify({ error: (err as Error).message, ledgerPath: partialPath }, null, 2) + "\n",
      );
    } else {
      process.stdout.write(banner(c, `deploy ${intent.app.name}`));
      process.stdout.write("\n" + c.red("✗ " + (err as Error).message) + "\n");
      if (partialPath) {
        process.stdout.write(
          c.yellow(
            `  ⚠ Partial deploy — resource group ${rg} may hold live resources. Ledger: ${partialPath}\n`,
          ) + c.dim(`  Tear it down with: az group delete -n ${rg} --yes --no-wait\n`),
        );
      }
    }
    return 1;
  }

  // Persist the ledger on a real apply so `ship` can adopt this deployment.
  let ledgerPath: string | undefined;
  if (result.ledger) {
    ledgerPath = persistLedger(root, result.ledger);
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ ...result, ledgerPath }, null, 2) + "\n");
    return 0;
  }

  const mode = result.applied ? c.dim("(live · resources created)") : c.dim("(what-if only)");
  process.stdout.write(banner(c, `deploy ${intent.app.name}  ${mode}`));
  process.stdout.write(c.dim(`  resource group ${rg} · region ${region}\n\n`));
  for (const step of result.steps) {
    process.stdout.write("  " + c.green("✓") + " " + step + "\n");
  }
  if (result.applied) {
    process.stdout.write("\n" + c.bold("Deployed.") + " Real Azure resources are live.\n");
    if (ledgerPath) process.stdout.write(c.dim(`  ledger written to ${ledgerPath}\n`));
    process.stdout.write(
      c.dim(`  Harden it into a reviewed pipeline: azx ship ${basename(root)} --create-repo <owner/name>\n`),
    );
  } else {
    process.stdout.write("\n" + c.dim("What-if only — re-run with --yes to create the resources.\n"));
  }
  return 0;
}

/** Load a local-deploy ledger from `<root>/.azx/deploy.json`, if one exists. */
function loadLedger(root: string): DeployLedger | undefined {
  const p = join(root, ".azx", "deploy.json");
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DeployLedger;
  } catch {
    return undefined;
  }
}

/** Write a ledger to `<root>/.azx/deploy.json`, returning the path written. */
function persistLedger(root: string, ledger: DeployLedger): string {
  const azxDir = join(root, ".azx");
  mkdirSync(azxDir, { recursive: true });
  const p = join(azxDir, "deploy.json");
  writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n");
  return p;
}

/**
 * `azx ship <path> [--create-repo owner/name] [--deploy] [--private] [--out dir]`
 *
 * The "source repo + CI/CD" mode. Builds the full scaffold (Bicep + deploy
 * pipeline), then:
 *   - default (no --create-repo): DRY RUN. Writes the scaffold to --out (or a
 *     repo-named dir) and prints the exact git/gh commands it *would* run.
 *   - --create-repo owner/name: creates + pushes a real GitHub repo via `gh`;
 *     with --deploy, also triggers the workflow so the pipeline does the real
 *     Azure deploy (via OIDC). azx itself still makes zero Azure calls.
 */
function cmdShip(repoArg: string, values: Values, c: Color): number {
  const root = resolve(repoArg);
  const { intent, plan, bicep } = buildAll(root, values);

  const ledger = loadLedger(root);
  const shipOpts = {
    repo: values["create-repo"],
    visibility: (values.private === false ? "public" : "private") as "public" | "private",
    deploy: values.deploy,
    outDir: values.out,
    ledger,
  };

  // Verify the adoption is real: if the freshly generated template no longer
  // matches what local deploy applied, the pipeline's first what-if will NOT be a
  // no-op. Compute this as structured data so --json / CI consumers can't miss it,
  // and warn loudly in human mode rather than let the "clean handoff" claim break.
  let drift: { expectedHash: string; actualHash: string } | undefined;
  if (ledger?.templateHash) {
    const currentHash = createHash("sha256").update(bicep).digest("hex");
    if (currentHash !== ledger.templateHash) {
      drift = { expectedHash: ledger.templateHash, actualHash: currentHash };
    }
  }
  const adoption = ledger
    ? { drift: !!drift, partial: !!ledger.partial, ...(drift ?? {}) }
    : undefined;

  if (!values.json) {
    if (drift) {
      process.stdout.write(
        c.yellow(
          "⚠ The generated Bicep differs from the template recorded in .azx/deploy.json —\n" +
            "  the pipeline's first what-if will show changes, not a clean no-op. Re-run\n" +
            "  `azx up --local-deploy` to refresh the ledger, or review the what-if before approving.\n\n",
        ),
      );
    }
    if (ledger?.partial) {
      process.stdout.write(
        c.yellow(
          "⚠ .azx/deploy.json is from a PARTIAL (failed) local deploy — some resources may be\n" +
            "  missing, so the pipeline's first what-if will show creates, not a no-op. The\n" +
            "  generated README flags this; review the first run before approving.\n\n",
        ),
      );
    }
  }

  // Budget block is a hard stop: never ship a plan a guardrail refused.
  if (plan.budget.blocked) {
    if (values.json) {
      process.stdout.write(
        JSON.stringify({ error: "blocked by budget guardrail", warnings: plan.budget.warnings }, null, 2) + "\n",
      );
    } else {
      process.stdout.write(banner(c, `ship ${intent.app.name}`));
      process.stdout.write(c.red("\n✗ Blocked by budget guardrail — refusing to ship.\n"));
      for (const w of plan.budget.warnings) process.stdout.write("  " + c.yellow("⚠ " + w) + "\n");
    }
    return 1;
  }

  const execute = !!values["create-repo"];

  if (execute) {
    const result = runShip(intent, plan, bicep, shipOpts);
    if (values.json) {
      process.stdout.write(JSON.stringify({ ...result, adoption }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(banner(c, `ship ${intent.app.name}  ${c.dim("(live)")}`));
    process.stdout.write(c.dim(`  scaffold written to ${result.outDir}\n`));
    for (const step of result.steps) {
      process.stdout.write("  " + c.green("✓") + " " + step.description + "\n");
    }
    process.stdout.write(
      "\n" + c.bold("Shipped.") + " The deploy pipeline now owns the real Azure deployment.\n",
    );
    if (!values.deploy) {
      process.stdout.write(
        c.dim(`  Trigger it with: gh workflow run deploy.yml --repo ${values["create-repo"]}\n`),
      );
    }
    return 0;
  }

  // Dry run: plan the steps, write scaffold if --out given, print what would run.
  const planned = shipSteps(intent, plan, bicep, shipOpts);
  if (values.out) writeScaffoldFiles(planned.outDir, planned.files);

  if (values.json) {
    process.stdout.write(JSON.stringify({ ...planned, executed: false, adoption }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(banner(c, `ship ${intent.app.name}  ${c.dim("(dry-run — no repo created)")}`));
  process.stdout.write("\n" + c.bold("Scaffold\n"));
  for (const f of planned.files) process.stdout.write("  " + c.dim("•") + " " + f.path + "\n");
  if (values.out) process.stdout.write(c.dim(`\n  written to ${planned.outDir}\n`));

  process.stdout.write("\n" + c.bold("Would run\n"));
  for (const step of planned.steps) {
    process.stdout.write("  " + c.dim("$ ") + renderStep(step) + "\n");
    process.stdout.write("      " + c.dim(step.description) + "\n");
  }
  process.stdout.write(
    "\n" +
      c.dim("Add --create-repo <owner/name> to create + push the repo (needs `gh` auth).\n") +
      c.dim("Add --deploy to also trigger the pipeline (real Azure deploy via OIDC).\n"),
  );
  return 0;
}

/** Render a ShipStep as a copy-pasteable command line. */
function renderStep(step: ShipStep): string {
  const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
  return [step.cmd, ...step.args.map(quote)].join(" ");
}

function cmdSchema(values: Values): number {
  const schemaPath = fileURLToPath(new URL("../../app-intent.schema.json", import.meta.url));
  const text = readFileSync(schemaPath, "utf8");
  if (values.out) {
    writeFileSync(resolve(values.out), text);
    process.stdout.write(`Schema written to ${resolve(values.out)}\n`);
  } else {
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderApp(scan: RepoScan, c: Color): string {
  const a = scan.app;
  const bits = [
    `${c.dim("root")}      ${a.root}`,
    `${c.dim("framework")} ${a.framework ?? "—"}`,
    `${c.dim("language")}  ${a.language ?? "—"}`,
    `${c.dim("runtime")}   ${a.runtime ?? "—"}`,
  ];
  return bits.map((b) => "  " + b).join("\n") + "\n";
}

function renderSignals(signals: RepoScan["signals"], conf: Map<string, Confidence>, c: Color): string {
  if (signals.length === 0) return c.dim("  (no signals detected)\n");
  const rows = signals.map((s) => ({
    kind: s.kind,
    signal: truncate(s.signal, 46),
    conclusion: truncate(s.conclusion, 40),
    conf: s.capability ? conf.get(String(s.capability)) ?? "" : "",
  }));
  const w = {
    kind: Math.max(4, ...rows.map((r) => r.kind.length)),
    signal: Math.max(6, ...rows.map((r) => r.signal.length)),
    conclusion: Math.max(10, ...rows.map((r) => r.conclusion.length)),
  };
  const head =
    "  " +
    pad("KIND", w.kind) +
    "  " +
    pad("SIGNAL", w.signal) +
    "  " +
    pad("CONCLUSION", w.conclusion) +
    "  CONF";
  const lines = [c.dim(head)];
  for (const r of rows) {
    lines.push(
      "  " +
        pad(r.kind, w.kind) +
        "  " +
        pad(r.signal, w.signal) +
        "  " +
        pad(r.conclusion, w.conclusion) +
        "  " +
        colorConfidence(r.conf, c),
    );
  }
  return lines.join("\n") + "\n";
}

function renderIntentJson(intent: AppIntent): string {
  // Compact but complete: the exact POST /v1/intent request body plus evidence.
  return JSON.stringify(
    {
      version: intent.version,
      app: intent.app,
      needs: intent.needs,
      guardrails: intent.guardrails,
      budget: intent.budget,
    },
    null,
    2,
  );
}

function renderPlan(plan: AzurePlan, c: Color): string {
  const lines: string[] = [];
  for (const line of plan.summary) lines.push("  " + line);
  if (plan.guardrailNotes.length) {
    lines.push("");
    lines.push("  " + c.bold("Guardrails applied:"));
    for (const n of plan.guardrailNotes) lines.push("    " + c.yellow("• " + n));
  }
  if (plan.warnings.length) {
    lines.push("");
    for (const w of plan.warnings) lines.push("  " + c.yellow("⚠ " + w));
  }
  if (plan.budget.warnings.length) {
    lines.push("");
    for (const w of plan.budget.warnings) lines.push("  " + c.yellow("⚠ " + w));
  }
  return lines.join("\n") + "\n";
}

function renderConfirmations(confirmations: Confirmation[], c: Color): string {
  if (confirmations.length === 0) return "";
  const lines: string[] = ["", c.bold("Confirmations  ") + c.dim("(medium/low confidence — confirm before apply)")];
  for (const cf of confirmations) {
    lines.push("  " + colorConfidence(cf.confidence, c) + "  " + c.bold(cf.question));
    lines.push("    " + c.dim(cf.why));
    if (cf.options?.length) lines.push("    options: " + cf.options.join(" / "));
    if (cf.assumption) lines.push("    " + c.dim("assumption if you do nothing: ") + cf.assumption);
  }
  return lines.join("\n") + "\n";
}

function renderDiff(diff: PlanDiff, c: Color): string {
  const sym: Record<ChangeAction, string> = {
    create: "+",
    modify: "~",
    destroy: "-",
    "no-change": " ",
  };
  const paint = (action: ChangeAction, s: string): string => {
    if (action === "create") return c.green(s);
    if (action === "modify") return c.yellow(s);
    if (action === "destroy") return c.red(s);
    return c.dim(s);
  };

  const lines: string[] = [];
  const baselineLabel =
    diff.baseline === "greenfield" ? "greenfield (no prior plan)" : "prior plan";
  lines.push("  " + c.dim(`baseline: ${baselineLabel} · region ${diff.region}`));
  lines.push("");

  const shown = diff.changes.filter((ch) => ch.action !== "no-change");
  if (shown.length === 0) {
    lines.push("  " + c.dim("No changes. Target plan matches the baseline."));
  }
  for (const ch of shown) {
    lines.push("  " + paint(ch.action, sym[ch.action]) + " " + ch.id + "  " + c.dim(ch.type));
    if (ch.action === "modify" && ch.deltas) {
      for (const d of ch.deltas) {
        lines.push(
          "      " +
            c.dim(d.field + ": ") +
            formatDeltaVal(d.before) +
            c.dim(" → ") +
            formatDeltaVal(d.after),
        );
      }
    }
  }

  if (diff.summary.noChange > 0) {
    lines.push("  " + c.dim(`(${diff.summary.noChange} unchanged)`));
  }

  const s = diff.summary;
  lines.push("");
  lines.push(
    "  " +
      c.bold("Plan: ") +
      c.green(`+${s.create} to create`) +
      ", " +
      c.yellow(`~${s.modify} to change`) +
      ", " +
      c.red(`-${s.destroy} to destroy`),
  );
  return lines.join("\n") + "\n";
}

function formatDeltaVal(v: unknown): string {
  if (v === undefined) return "(none)";
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  if (typeof v === "object") return truncate(JSON.stringify(v), 60);
  return String(v);
}

function confidenceByCapability(intent: AppIntent): Map<string, Confidence> {
  const m = new Map<string, Confidence>();
  for (const need of intent.needs) m.set(String(need.capability), need.confidence);
  return m;
}

// ---------------------------------------------------------------------------
// Small ANSI color util (respects NO_COLOR / --no-color / non-TTY)
// ---------------------------------------------------------------------------

interface Color {
  dim: (s: string) => string;
  bold: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  cyan: (s: string) => string;
}

function makeColor(enabled: boolean): Color {
  const wrap = (open: number, close: number) => (s: string) =>
    enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s;
  return {
    dim: wrap(2, 22),
    bold: wrap(1, 22),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
    cyan: wrap(36, 39),
  };
}

function colorConfidence(conf: string, c: Color): string {
  if (conf === "high") return c.green("high");
  if (conf === "medium") return c.yellow("medium");
  if (conf === "low") return c.red("low");
  return c.dim(conf || "—");
}

function banner(c: Color, title: string): string {
  return c.cyan("azx") + " " + c.bold(title) + "\n";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function hr(): string {
  return "─".repeat(76);
}

function readVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return "azx " + (pkg.version ?? "0.0.0");
  } catch {
    return "azx 0.0.0";
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      "azx — App Intent Service (POC #1, dry-run engine)",
      "",
      "USAGE",
      "  azx <command> [path] [flags]",
      "",
      "COMMANDS",
      "  plan <path>    read repo → extract intent → resolve Azure plan + Bicep (stages 0→2)",
      "  scan <path>    detect the app and print the signals table (stage 0)",
      "  bicep <path>   print just the generated main.bicep",
      "  what-if <path> offline plan diff vs a prior plan (--against) + approval gate",
      "  up <path>      dry-run stub; add --local-deploy to REALLY deploy via `az` (what-if gated)",
      "  ship <path>    scaffold a deploy repo (Bicep + CI/CD) and, with --create-repo,",
      "                 create + push it so its pipeline does the real Azure deploy (OIDC)",
      "  schema         print the open app-intent.schema.json contract",
      "  help           show this help",
      "",
      "FLAGS",
      "  --json                 machine-readable output",
      "  --guardrails <file>    apply a guardrails.yaml (policy wins over repo)",
      "  --subscription <file>  budget context (mock subscription.json)",
      "  --against <plan.json>  what-if: baseline plan to diff against (azx plan --json)",
      "  --yes                  approve: what-if apply / up --local-deploy real deploy",
      "  --out <file|dir>       write Bicep/schema to a file, or the ship scaffold to a dir",
      "  --scaffold <dir>       plan: also write the full deploy repo tree (Bicep + CI/CD)",
      "  --create-repo <o/n>    ship: create + push a real GitHub repo (owner/name)",
      "  --deploy               ship: trigger the deploy pipeline after push (real deploy)",
      "  --private/--no-private ship: repo visibility (default: private)",
      "  --local-deploy         up: really deploy to Azure via `az` (needs `az login`)",
      "  --resource-group <rg>  up --local-deploy: target resource group (default rg-<app>)",
      "  --region <r>           up --local-deploy: target region (default: plan region)",
      "  --pg-password <p>      up --local-deploy: PostgreSQL admin password (if provisioned)",
      "  --subscription-id <id> up --local-deploy: pin the Azure subscription",
      "  --no-bicep             omit the Bicep block from 'plan' output",
      "  --no-color             disable ANSI color",
      "  --version              print version",
      "",
      "Two ways to reach real Azure — both keep plan and apply separate:",
      "  • `up --local-deploy` — imperative inner loop; `az` deploys, writes .azx/deploy.json.",
      "  • `ship --create-repo` — codify into a GitHub repo whose OIDC pipeline deploys;",
      "    it adopts .azx/deploy.json so the first what-if is typically a no-op (review it).",
      "Everything else (plan/scaffold/what-if/up) is a fully offline dry-run.",
      "",
    ].join("\n"),
  );
}

process.exit(main(process.argv.slice(2)));
