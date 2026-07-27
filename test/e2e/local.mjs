#!/usr/bin/env node
// test/e2e/local.mjs
//
// Run the FULL azx E2E gate pipeline locally, against your own `az login`.
// Same four gates as CI (.github/workflows/e2e.yml), reconciled by the same
// assert.mjs — but no OIDC federation, no repo variables, no cloud runner.
//
//   plan     -> node dist/src/cli.js plan  <app> --json
//   bicep    -> node dist/src/cli.js bicep <app> --out
//   compile  -> az bicep build
//   what-if  -> az deployment group what-if  (opt-in: --whatif; uses an ephemeral RG)
//   assert   -> node test/e2e/assert.mjs  (plan-match hard gate + compile/what-if reconcile)
//
// The what-if gate is the ONLY gate that talks to Azure. It is preflight only:
// it creates an EMPTY resource group, validates the template, and deletes the RG.
// Nothing is deployed. Omit --whatif to mirror a credential-less CI run (what-if SKIP).
//
// Usage:
//   node test/e2e/local.mjs                         # all apps, offline gates only (what-if SKIP)
//   node test/e2e/local.mjs --app next-minimal --whatif
//   node test/e2e/local.mjs --whatif --sub <subId>  # all apps incl. real what-if
//   node test/e2e/local.mjs --app next-minimal --whatif --keep   # leave RG for inspection
//
// Flags:
//   --app <name|all>   fixture under test/e2e/apps (default: all)
//   --whatif           actually run the Azure what-if gate (needs `az login`)
//   --sub <id>         subscription for what-if (default: current `az account` context)
//   --region <r>       region for the ephemeral RG (default: expectations.json region)
//   --keep             do not delete the ephemeral RG (for manual inspection)
//
// Exit code: non-zero if ANY app hard-fails reconciliation (matches CI semantics).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const workDir = join(__dirname, ".local");
const isWin = process.platform === "win32";

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { whatif: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--whatif") a.whatif = true;
    else if (k === "--keep") a.keep = true;
    else if (k?.startsWith("--")) a[k.slice(2)] = argv[++i];
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));

const spec = JSON.parse(readFileSync(join(__dirname, "expectations.json"), "utf8"));
const region = args.region ?? spec.region;
const allApps = Object.keys(spec.apps);
const apps = !args.app || args.app === "all" ? allApps : [args.app];
for (const app of apps) {
  if (!spec.apps[app]) {
    console.error(`unknown app '${app}'. known: ${allApps.join(", ")}`);
    process.exit(2);
  }
}

// ---- shell helper -----------------------------------------------------------
// Our paths contain no spaces (repo under C:\Users\stema\azx-regen), so a single
// shell string is safe and keeps `az` (a .cmd shim on Windows) resolvable.
function run(cmd, { capture = true } = {}) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status ?? (r.error ? 1 : 0),
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    combined: `${r.stdout ?? ""}${r.stderr ?? ""}`,
  };
}

// ---- azure preflight (only when --whatif) -----------------------------------
if (args.whatif) {
  const acct = run(`az account show -o json`);
  if (acct.status !== 0) {
    console.error("--whatif requires an active `az login`. Run `az login` first, or drop --whatif.");
    process.exit(2);
  }
  const sub = args.sub ?? JSON.parse(acct.stdout).id;
  if (args.sub) run(`az account set --subscription ${args.sub}`);
  const who = JSON.parse(run(`az account show -o json`).stdout);
  console.log(`what-if gate ENABLED  sub="${who.name}" (${who.id})  region=${region}`);
  run(`az bicep install`); // idempotent; ensures `az bicep build` + what-if bicep support
  args._sub = sub;
} else {
  console.log("what-if gate DISABLED (offline gates only; pass --whatif to exercise Azure preflight)");
}

mkdirSync(workDir, { recursive: true });

// ---- per-app pipeline -------------------------------------------------------
const cli = `node "${join(repoRoot, "dist", "src", "cli.js")}"`;
const results = [];

for (const app of apps) {
  const appDir = join("test", "e2e", "apps", app); // repo-relative for tidy azx logs
  const bicepPath = join(workDir, `main-${app}.bicep`);
  const planPath = join(workDir, `plan-${app}.json`);
  console.log(`\n=== ${app} ===============================================`);

  // plan --json
  const planRun = run(`${cli} plan "${appDir}" --json`);
  if (planRun.status !== 0) {
    console.error(`azx plan failed:\n${planRun.combined.split("\n").slice(0, 8).join("\n")}`);
    results.push({ app, hardFail: true, note: "azx plan failed" });
    continue;
  }
  writeFileSync(planPath, planRun.stdout);

  // bicep --out
  const bicepRun = run(`${cli} bicep "${appDir}" --out "${bicepPath}"`);
  if (bicepRun.status !== 0 || !existsSync(bicepPath)) {
    console.error(`azx bicep failed:\n${bicepRun.combined.split("\n").slice(0, 8).join("\n")}`);
    results.push({ app, hardFail: true, note: "azx bicep failed" });
    continue;
  }

  // compile gate
  const compileRun = run(`az bicep build --file "${bicepPath}" --stdout`);
  const compile = compileRun.status === 0 ? "pass" : "fail";
  if (compile === "fail") {
    const firstErr = compileRun.combined.split("\n").find((l) => /error|BCP\d+/i.test(l)) ?? "";
    console.log(`  compile: FAIL  ${firstErr.trim()}`);
  } else {
    console.log(`  compile: pass`);
  }

  // what-if gate
  let whatif = "skip";
  if (args.whatif && compile === "pass") {
    const rg = `azx-e2e-local-${app}-${Date.now()}`;
    const created = run(`az group create -n ${rg} -l ${region} --tags azx-e2e=1 ttl=2h -o none`);
    if (created.status !== 0) {
      console.log(`  what-if: SKIP (could not create RG — check permissions on the subscription)`);
      console.log(`           ${created.combined.split("\n")[0]}`);
    } else {
      const wi = run(`az deployment group what-if -g ${rg} --template-file "${bicepPath}" --no-pretty-print`);
      whatif = wi.status === 0 ? "pass" : "fail";
      writeFileSync(join(workDir, `whatif-${app}.txt`), wi.combined);
      const sig = spec.apps[app].whatifKnownIssue?.match(/([A-Z][A-Za-z]+MustContain[A-Za-z]+)/)?.[1];
      const hitKnown = sig && wi.combined.includes(sig);
      const head = wi.combined.split("\n").filter((l) => l.trim()).slice(0, 4).join("\n           ");
      console.log(`  what-if: ${whatif.toUpperCase()}${hitKnown ? `  (bug2 confirmed: ${sig})` : ""}`);
      console.log(`           ${head}`);
      if (!args.keep) run(`az group delete -n ${rg} --yes --no-wait -o none`);
      else console.log(`           RG kept: ${rg}`);
    }
  } else if (args.whatif && compile === "fail") {
    console.log(`  what-if: SKIP (template does not compile)`);
  }

  // reconcile via the SAME asserter CI uses
  const assert = run(
    `node "${join(__dirname, "assert.mjs")}" --app ${app} --plan "${planPath}" --compile ${compile} --whatif ${whatif}`,
  );
  process.stdout.write(assert.stdout);
  if (assert.stderr.trim()) process.stderr.write(assert.stderr);
  results.push({ app, hardFail: assert.status !== 0, compile, whatif });
}

// ---- summary ----------------------------------------------------------------
console.log(`\n================= SUMMARY =================`);
let anyFail = false;
for (const r of results) {
  anyFail ||= r.hardFail;
  const tag = r.hardFail ? "HARD-FAIL" : "ok";
  const extra = r.note ? `  (${r.note})` : `  compile=${r.compile} what-if=${r.whatif}`;
  console.log(`  ${tag.padEnd(9)} ${r.app}${extra}`);
}
console.log(`==========================================`);
process.exit(anyFail ? 1 : 0);
