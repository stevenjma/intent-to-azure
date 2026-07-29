#!/usr/bin/env node
// test/e2e/assert.mjs
//
// Reconciles one E2E fixture's observed azx output against test/e2e/expectations.json
// and reports four DISTINCT gates:
//
//   analyzed   - azx plan --json produced valid JSON (implicit: this script parsed it)
//   plan-match - intent.needs + plan.resources + region match expectations EXACTLY (deterministic; hard gate)
//   compile    - observed `az bicep build` outcome vs expected (known azx codegen bugs allowed, but a
//                silent flip -> hard fail so expectations track reality)
//   what-if    - observed `az deployment group what-if` outcome vs expected (SKIPPED when no creds)
//
// Usage:
//   node test/e2e/assert.mjs --app <name> --plan <plan.json> [--compile pass|fail] [--whatif pass|fail|skip]
//
// Exit code: 0 iff plan-match holds AND compile/what-if reconcile. Non-zero otherwise.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith("--")) continue;
    a[k.slice(2)] = argv[i + 1];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const app = args.app;
if (!app || !args.plan) {
  console.error("usage: assert.mjs --app <name> --plan <plan.json> [--compile pass|fail] [--whatif pass|fail|skip]");
  process.exit(2);
}
const observedCompile = args.compile ?? "skip"; // pass | fail | skip
const observedWhatif = args.whatif ?? "skip";   // pass | fail | skip

const spec = JSON.parse(readFileSync(join(__dirname, "expectations.json"), "utf8"));
const exp = spec.apps[app];
if (!exp) {
  console.error(`no expectations entry for app '${app}' in expectations.json`);
  process.exit(2);
}
const expectedRegion = spec.region;

const plan = JSON.parse(readFileSync(args.plan, "utf8"));

// ---- normalize observed azx output -------------------------------------------------
const obsNeeds = (plan.intent?.needs ?? [])
  .map((n) => (typeof n === "string" ? n : n.capability))
  .filter(Boolean)
  .sort();
const obsRegion = plan.plan?.region;
const obsResources = (plan.plan?.resources ?? []).map((r) => ({ id: r.id, type: r.type }));

const expNeeds = [...exp.needs].sort();
const expResources = exp.resources;

// ---- gate results ------------------------------------------------------------------
const gates = []; // { name, status: 'pass'|'fail'|'known'|'skip', detail }
let hardFail = false;

function eqArr(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// analyzed (we got here => JSON parsed)
gates.push({ name: "analyzed", status: "pass", detail: `${plan.intent?.app?.name ?? "?"} (${plan.intent?.app?.framework ?? "?"})` });

// plan-match: needs + region + resources (exact set, type-checked)
const planProblems = [];
if (!eqArr(obsNeeds, expNeeds)) planProblems.push(`needs: expected [${expNeeds.join(", ")}] got [${obsNeeds.join(", ")}]`);
if (obsRegion !== expectedRegion) planProblems.push(`region: expected ${expectedRegion} got ${obsRegion}`);

const expIds = expResources.map((r) => r.id).sort();
const obsIds = obsResources.map((r) => r.id).sort();
if (!eqArr(obsIds, expIds)) {
  planProblems.push(`resource ids: expected [${expIds.join(", ")}] got [${obsIds.join(", ")}]`);
} else {
  for (const er of expResources) {
    const got = obsResources.find((r) => r.id === er.id);
    if (got.type !== er.type) planProblems.push(`resource '${er.id}' type: expected ${er.type} got ${got.type}`);
  }
}
if (planProblems.length) {
  hardFail = true;
  gates.push({ name: "plan-match", status: "fail", detail: planProblems.join("; ") });
} else {
  gates.push({ name: "plan-match", status: "pass", detail: `${expNeeds.length} needs, ${expIds.length} resources, ${expectedRegion}` });
}

// compile reconciliation
{
  const want = exp.compile; // pass | fail
  const got = observedCompile; // pass | fail | skip
  if (got === "skip") {
    gates.push({ name: "compile", status: "skip", detail: "not run" });
  } else if (got === want) {
    if (want === "fail") {
      gates.push({ name: "compile", status: "known", detail: `expected FAIL — ${exp.compileKnownIssue ?? "known issue"}` });
    } else {
      gates.push({ name: "compile", status: "pass", detail: "az bicep build exit 0" });
    }
  } else {
    hardFail = true;
    const hint =
      got === "pass" && want === "fail"
        ? "compile now PASSES — azx bug appears fixed; flip expectations.json compile to 'pass'"
        : "compile REGRESSED — emitted bicep no longer builds";
    gates.push({ name: "compile", status: "fail", detail: hint });
  }
}

// what-if reconciliation (creds-absent skip is always neutral)
{
  const want = exp.whatif; // pass | fail | skip
  const got = observedWhatif; // pass | fail | skip
  if (got === "skip") {
    gates.push({ name: "what-if", status: "skip", detail: want === "skip" ? (exp.whatifKnownIssue ?? "n/a") : "no Azure creds (or compile failed) — gate not exercised" });
  } else if (got === want) {
    if (want === "fail") {
      gates.push({ name: "what-if", status: "known", detail: `expected FAIL — ${exp.whatifKnownIssue ?? "known issue"}` });
    } else {
      gates.push({ name: "what-if", status: "pass", detail: "what-if preflight succeeded" });
    }
  } else {
    hardFail = true;
    const hint =
      got === "pass" && want === "fail"
        ? "what-if now PASSES — azx bug appears fixed; flip expectations.json whatif to 'pass'"
        : `what-if outcome '${got}' != expected '${want}'`;
    gates.push({ name: "what-if", status: "fail", detail: hint });
  }
}

// ---- report ------------------------------------------------------------------------
const glyph = { pass: "PASS", fail: "FAIL", known: "KNOWN", skip: "SKIP" };
const lines = [];
lines.push(`### ${app}${hardFail ? "  \u274c" : "  \u2705"}`);
lines.push("");
lines.push("| gate | result | detail |");
lines.push("| --- | --- | --- |");
for (const g of gates) lines.push(`| ${g.name} | ${glyph[g.status]} | ${g.detail} |`);
lines.push("");

const report = lines.join("\n");
console.log(report);

if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
  } catch {}
}

process.exit(hardFail ? 1 : 0);
