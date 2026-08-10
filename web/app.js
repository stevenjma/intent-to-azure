/**
 * app.js — SPA orchestration: auth buttons, repo analyze, render, deploy, ship.
 *
 * The engine (scan → intent → plan → bicep → scaffold → ARM template) runs entirely
 * in this page from ./engine/web-engine.js. Azure + GitHub I/O live in azure.js /
 * github.js. This file is glue + rendering only; it never persists tokens.
 */

import { resolveScan, generateArmTemplate, planNeedsPgPassword } from "./engine/web-engine.js";
import {
  githubSignIn,
  githubSignOut,
  githubSignedIn,
  githubUser,
  fetchRepoFiles,
  createRepoAndPush,
  listAccessibleRepos,
  searchRepos,
} from "./github.js";
import {
  azureSignIn,
  azureSignOut,
  azureSignedIn,
  listSubscriptions,
  ensureResourceGroup,
  whatIf,
  deploy,
} from "./azure.js";

const cfg = window.AZX_CONFIG || {};
const $ = (id) => document.getElementById(id);

/** Current analysis result: { intent, plan, bicep, scaffold, appName }. */
let current = null;
/** True once a what-if has succeeded for the current deploy inputs (gates apply). */
let whatIfOk = false;

// --------------------------------------------------------------------------
// Setup / boot
// --------------------------------------------------------------------------

function boot() {
  const missing = !cfg.azureClientId || !cfg.githubClientId || !cfg.githubWorkerUrl;
  if (missing) $("setup-banner").classList.remove("hidden");

  $("btn-azure").addEventListener("click", onAzureSignIn);
  $("btn-github").addEventListener("click", onGithubSignIn);
  $("repo-form").addEventListener("submit", onAnalyze);
  $("repo-input").addEventListener("input", onRepoInput);
  $("btn-whatif").addEventListener("click", onWhatIf);
  $("btn-apply").addEventListener("click", onApply);
  $("btn-ship").addEventListener("click", onShip);

  for (const t of document.querySelectorAll(".tab")) {
    t.addEventListener("click", () => selectTab(t.dataset.tab));
  }
  // Any change to deploy inputs invalidates a prior what-if.
  for (const id of ["sub-select", "rg-input", "region-input"]) {
    $(id).addEventListener("input", () => setWhatIfOk(false));
  }
}

function setDot(btnId, state) {
  $(btnId).querySelector(".dot").dataset.state = state;
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

async function onAzureSignIn() {
  setDot("btn-azure", "pending");
  try {
    const acct = await azureSignIn(cfg);
    setDot("btn-azure", "in");
    $("btn-azure").lastChild.textContent = ` ${acct.username || "Signed in"}`;
    await populateSubscriptions();
    refreshDeployAvailability();
  } catch (err) {
    setDot("btn-azure", "out");
    alert(`Azure sign-in failed: ${err.message}`);
  }
}

async function onGithubSignIn() {
  setDot("btn-github", "pending");
  try {
    const user = await githubSignIn(cfg);
    setDot("btn-github", "in");
    $("btn-github").lastChild.textContent = ` ${user.login}`;
    refreshShipAvailability();
    loadRepoChoices();
  } catch (err) {
    setDot("btn-github", "out");
    alert(`GitHub sign-in failed: ${err.message}`);
  }
}

// --------------------------------------------------------------------------
// Repo picker (type-ahead over the user's accessible repos)
// --------------------------------------------------------------------------

/** Known repo rows for the datalist, keyed by full name (dedup across sources). */
const repoChoices = new Map();
let repoSearchTimer = null;

function renderRepoOptions() {
  const dl = $("repo-list");
  const rows = [...repoChoices.values()]
    .sort((a, b) => (b.pushedAt || "").localeCompare(a.pushedAt || ""))
    .slice(0, 100);
  dl.replaceChildren(
    ...rows.map((r) => {
      const o = document.createElement("option");
      o.value = r.fullName;
      o.label = r.private ? "private" : "public";
      return o;
    }),
  );
}

function mergeRepos(rows) {
  for (const r of rows) if (r.fullName) repoChoices.set(r.fullName, r);
  renderRepoOptions();
}

/** After sign-in, seed the picker with the user's most-recently-pushed repos. */
async function loadRepoChoices() {
  $("repo-input").placeholder = "Loading your repos…";
  try {
    mergeRepos(await listAccessibleRepos());
    $("repo-input").placeholder = "owner/repo  (type to search your repos)";
  } catch (err) {
    $("repo-input").placeholder = "owner/repo";
    // Non-fatal: manual entry still works.
    console.warn("Could not list repos:", err.message);
  }
}

/** Debounced server-side search for queries beyond the seeded page set. */
function onRepoInput() {
  if (!githubSignedIn()) return;
  const q = $("repo-input").value.trim();
  if (q.length < 2 || q.includes("/")) return; // full owner/repo already narrows locally
  clearTimeout(repoSearchTimer);
  repoSearchTimer = setTimeout(async () => {
    try {
      mergeRepos(await searchRepos(q));
    } catch (err) {
      console.warn("Repo search failed:", err.message);
    }
  }, 300);
}

// --------------------------------------------------------------------------
// Analyze
// --------------------------------------------------------------------------

async function onAnalyze(ev) {
  ev.preventDefault();
  const ownerRepo = $("repo-input").value.trim();
  const ref = $("ref-input").value.trim();
  if (!ownerRepo) return;

  const status = $("repo-status");
  status.className = "status";
  status.textContent = "Fetching repo files…";
  try {
    const { repo, files, truncated } = await fetchRepoFiles(ownerRepo, ref);
    if (files.size === 0) throw new Error("No readable text files found in that repo/branch.");
    status.textContent = `Scanned ${files.size} files${truncated ? " (truncated)" : ""}. Resolving plan…`;

    const result = resolveScan(repo, files);
    current = { ...result, appName: repo };
    renderResults(current);

    status.className = "status ok";
    status.textContent = `Done — ${result.plan.resources.length} Azure resource(s) planned for “${repo}”.`;

    // Prime deploy defaults from the plan.
    $("rg-input").value = `rg-${slug(repo)}`;
    $("region-input").value = result.plan.region;
    $("ship-repo-input").value = `${slug(repo)}-infra`;
    setWhatIfOk(false);
    $("results").classList.remove("hidden");
    $("deploy").classList.remove("hidden");
    $("ship").classList.remove("hidden");
    refreshDeployAvailability();
    refreshShipAvailability();
  } catch (err) {
    status.className = "status err";
    status.textContent = err.message;
  }
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

function renderResults(r) {
  renderIntent(r.intent);
  renderPlan(r.plan);
  $("bicep-view").textContent = r.bicep;
  renderScaffold(r.scaffold);
  selectTab("intent");
}

function renderIntent(intent) {
  const app = intent.app || {};
  const needs = intent.needs || [];
  const rows = needs
    .map((n) => {
      const conf = (n.confidence || "").toLowerCase();
      return `<div class="card">
        <h3>${esc(n.capability)} <span class="pill ${conf}">${esc(n.confidence || "")}</span></h3>
        ${n.rationale ? `<div class="hint">${esc(n.rationale)}</div>` : ""}
      </div>`;
    })
    .join("");
  $("intent-view").innerHTML =
    `<div class="card"><h3>${esc(app.name || "app")}</h3>
     <div class="hint">${esc(app.language || "")} ${esc(app.framework || "")}</div></div>` +
    (rows || `<p class="hint">No capabilities inferred.</p>`);
}

function renderPlan(plan) {
  const summary = (plan.summary || []).map((s) => `<div>• ${esc(s)}</div>`).join("");
  const rows = plan.resources
    .map(
      (r) => `<div class="card">
        <h3><span class="pill create">create</span> ${esc(r.service || r.type)}</h3>
        <div class="hint">${esc(r.type)}${r.sku ? " · " + esc(r.sku) : ""} · ${esc(r.region)}</div>
        ${r.estimatedMonthlyUsd != null ? `<div class="hint">~$${esc(String(r.estimatedMonthlyUsd))}/mo</div>` : ""}
      </div>`,
    )
    .join("");
  const budget = plan.budget
    ? `<div class="card"><h3>Budget</h3><div class="hint">~$${esc(
        String(plan.budget.estimatedMonthlyUsd),
      )}/mo ${esc(plan.budget.currency || "")}${
        plan.budget.blocked ? " · <strong>BLOCKED by guardrail</strong>" : ""
      }</div></div>`
    : "";
  $("plan-view").innerHTML =
    budget + `<div class="card"><h3>Summary</h3><div class="hint">${summary}</div></div>` + rows;
}

function renderScaffold(files) {
  const list = files
    .map(
      (f) =>
        `<div class="tree-file" data-path="${esc(f.path)}">${esc(f.path)}<span class="sz">${f.content.length} B</span></div>`,
    )
    .join("");
  $("scaffold-view").innerHTML = `<div class="tree">${list}</div><pre id="scaffold-file" class="code"></pre>`;
  for (const el of $("scaffold-view").querySelectorAll(".tree-file")) {
    el.addEventListener("click", () => {
      const f = files.find((x) => x.path === el.dataset.path);
      $("scaffold-file").textContent = f ? f.content : "";
    });
  }
}

function selectTab(name) {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === name);
  for (const p of document.querySelectorAll(".tabpanel"))
    p.classList.toggle("active", p.dataset.panel === name);
}

// --------------------------------------------------------------------------
// Deploy
// --------------------------------------------------------------------------

async function populateSubscriptions() {
  const sel = $("sub-select");
  sel.innerHTML = "";
  const subs = await listSubscriptions();
  for (const s of subs) {
    const opt = document.createElement("option");
    opt.value = s.subscriptionId;
    opt.textContent = `${s.displayName} (${s.subscriptionId.slice(0, 8)}…)`;
    sel.appendChild(opt);
  }
  sel.disabled = subs.length === 0;
}

function refreshDeployAvailability() {
  const ready = Boolean(current) && azureSignedIn() && $("sub-select").value;
  $("btn-whatif").disabled = !ready;
  $("btn-apply").disabled = !ready || !whatIfOk;
}

function refreshShipAvailability() {
  $("btn-ship").disabled = !(current && githubSignedIn());
}

function setWhatIfOk(ok) {
  whatIfOk = ok;
  refreshDeployAvailability();
}

/** Collect deploy parameters, prompting for the PG password when the plan needs it. */
function deployParameters() {
  const params = {};
  if (planNeedsPgPassword(current.plan)) {
    const pw = window.prompt(
      "This plan provisions PostgreSQL. Enter an administrator password (@secure — not stored):",
    );
    if (!pw) throw new Error("PostgreSQL admin password is required to deploy this plan.");
    params.postgresAdminPassword = pw;
  }
  return params;
}

function deployInputs() {
  const subscriptionId = $("sub-select").value;
  const resourceGroup = $("rg-input").value.trim();
  const region = $("region-input").value.trim();
  if (!subscriptionId) throw new Error("Pick a subscription.");
  if (!resourceGroup) throw new Error("Enter a resource group name.");
  if (!region) throw new Error("Enter a region.");
  return { subscriptionId, resourceGroup, region };
}

function deploymentName() {
  return `azx-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function onWhatIf() {
  const log = $("deploy-log");
  log.textContent = "";
  try {
    const { subscriptionId, resourceGroup, region } = deployInputs();
    const params = deployParameters();
    const template = generateArmTemplate(current.plan);

    const write = (m) => (log.textContent += m + "\n");
    write(`▶ Ensuring resource group ${resourceGroup} (${region})…`);
    await ensureResourceGroup(subscriptionId, resourceGroup, region);
    write("▶ Running ARM what-if (no changes made)…");
    const result = await whatIf(
      subscriptionId,
      resourceGroup,
      deploymentName(),
      template,
      params,
      { onLog: write },
    );
    const changes = result?.changes || result?.properties?.changes || [];
    write(`\n✔ what-if complete — ${changes.length} predicted change(s):`);
    for (const c of changes) {
      write(`  ${c.changeType || "?"}  ${c.resourceId || c.after?.id || ""}`);
    }
    write("\nReview the predicted changes above, then click Deploy to apply.");
    setWhatIfOk(true);
  } catch (err) {
    $("deploy-log").textContent += `\n✖ ${err.message}\n`;
    setWhatIfOk(false);
  }
}

async function onApply() {
  if (!whatIfOk) return;
  const log = $("deploy-log");
  const write = (m) => (log.textContent += m + "\n");
  if (!window.confirm("Deploy real Azure resources now? This will incur cost.")) return;
  try {
    const { subscriptionId, resourceGroup, region } = deployInputs();
    const params = deployParameters();
    const template = generateArmTemplate(current.plan);
    write("\n▶ Deploying (creating resources)…");
    await ensureResourceGroup(subscriptionId, resourceGroup, region);
    const final = await deploy(
      subscriptionId,
      resourceGroup,
      deploymentName(),
      template,
      params,
      { onLog: write },
    );
    const state = final?.properties?.provisioningState || "Unknown";
    write(`\n✔ Deployment ${state}.`);
    const outputs = final?.properties?.outputs || {};
    for (const [k, v] of Object.entries(outputs)) write(`  output ${k} = ${v.value}`);
  } catch (err) {
    write(`\n✖ ${err.message}`);
  }
}

// --------------------------------------------------------------------------
// Ship (codify as a repo)
// --------------------------------------------------------------------------

async function onShip() {
  const log = $("ship-log");
  const write = (m) => (log.textContent += m + "\n");
  log.textContent = "";
  try {
    const name = $("ship-repo-input").value.trim();
    if (!name) throw new Error("Enter a name for the new repo.");
    const isPrivate = $("ship-private").checked;
    const files = current.scaffold.map((f) => ({ path: f.path, contents: f.content }));
    write(`▶ Creating ${isPrivate ? "private " : ""}repo “${name}” and pushing ${files.length} files…`);
    const res = await createRepoAndPush(
      name,
      isPrivate,
      files,
      `azx: infra scaffold for ${current.appName}`,
    );
    write(`\n✔ Pushed to ${res.htmlUrl}`);
    write("  Next: add AZURE_CLIENT_ID / TENANT_ID / SUBSCRIPTION_ID repo variables and");
    write("  run setup-azure-oidc.sh so the committed pipeline can deploy via OIDC.");
  } catch (err) {
    write(`\n✖ ${err.message}`);
  }
}

// --------------------------------------------------------------------------
// Utils
// --------------------------------------------------------------------------

function slug(s) {
  const out = String(s)
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "app";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

boot();
