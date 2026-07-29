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
import { readFileSync, writeFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";

import { readRepo, type RepoScan } from "./read-repo.js";
import { extractIntent } from "./extract-intent.js";
import { loadGuardrails, parseGuardrails } from "./guardrails.js";
import { loadBudget, normalizeBudget } from "./budget.js";
import { plan as planIntent } from "./plan.js";
import { generateBicep } from "./bicep.js";
import { dryRun } from "./run.js";
import { diffPlans } from "./diff.js";
import type { AppIntent, AzurePlan, ChangeAction, Confirmation, Guardrails, BudgetContext, Confidence, PlanDiff } from "./types.js";

interface Values {
  json?: boolean;
  guardrails?: string;
  subscription?: string;
  out?: string;
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

  if (values.json) {
    process.stdout.write(JSON.stringify({ intent, plan, bicep }, null, 2) + "\n");
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
  const { plan, bicep } = buildAll(root, values);
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
  return result.blocked ? 1 : 0;
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
      "  up <path>      STUB: print what would deploy (stage 3 — never deploys)",
      "  schema         print the open app-intent.schema.json contract",
      "  help           show this help",
      "",
      "FLAGS",
      "  --json                 machine-readable output",
      "  --guardrails <file>    apply a guardrails.yaml (policy wins over repo)",
      "  --subscription <file>  budget context (mock subscription.json)",
      "  --against <plan.json>  what-if: baseline plan to diff against (azx plan --json)",
      "  --yes                  what-if: auto-approve without the interactive prompt",
      "  --out <file>           write Bicep/schema to a file",
      "  --no-bicep             omit the Bicep block from 'plan' output",
      "  --no-color             disable ANSI color",
      "  --version              print version",
      "",
      "Everything is an offline dry-run. azx never calls Azure in POC #1.",
      "",
    ].join("\n"),
  );
}

process.exit(main(process.argv.slice(2)));
