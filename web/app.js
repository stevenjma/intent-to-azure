/**
 * app.js — SPA orchestration: auth buttons, repo analyze, render, deploy, ship.
 *
 * The engine (scan → intent → plan → bicep → scaffold → ARM template) runs entirely
 * in this page from ./engine/web-engine.js. Azure + GitHub I/O live in azure.js /
 * github.js. This file is glue + rendering only; it never persists tokens.
 */

import { resolveScan, generateArmTemplate, planNeedsPgPassword } from "./engine/web-engine.js?v=20260818a";
import {
  githubSignIn,
  githubSignOut,
  githubSignedIn,
  githubUser,
  handleGithubRedirect,
  restoreGithubSession,
  fetchRepoFiles,
  createRepoAndPush,
  listAccessibleRepos,
  searchRepos,
} from "./github.js?v=20260818a";
import {
  azureSignIn,
  azureSignOut,
  azureSignedIn,
  restoreAzureSession,
  listSubscriptions,
  resourceGroupExists,
  ensureResourceGroup,
  whatIf,
  deploy,
} from "./azure.js?v=20260818a";

const cfg = window.AZX_CONFIG || {};
const $ = (id) => document.getElementById(id);

/** Current analysis result: { intent, plan, bicep, scaffold, appName, hosting }. */
let current = null;
/** True once a what-if has succeeded for the current deploy inputs (gates apply). */
let whatIfOk = false;
let deployInputRevision = 0;
let approvedInputRevision = -1;
let analysisSequence = 0;
let analysisController = null;
let confirmationApprovalSequence = -1;

/** The linear stages. `codify`/`deploy` are the two "Act" spokes off `review`. */
const STAGES = ["source", "review", "codify", "deploy"];
/** The stage currently shown (exactly one `#stage-*` is visible at a time). */
let currentStage = "source";
/** Which act spoke the "Act" stepper item returns to (last one chosen). */
let lastAct = "codify";
/** Tracks fields the user has hand-edited so a re-analyze won't clobber them. */
const dirty = { rg: false, region: false, ship: false };

// --------------------------------------------------------------------------
// Setup / boot
// --------------------------------------------------------------------------

export function boot(oauthResult = null) {
  // Name every required identifier so the setup banner can say exactly what's
  // missing (self-host forkers hit partial-config states otherwise — DR-010).
  const REQUIRED = [
    ["azureClientId", "Entra SPA client ID (azureClientId)"],
    ["githubClientId", "GitHub OAuth App client ID (githubClientId)"],
    ["githubWorkerUrl", "token-exchange Worker URL (githubWorkerUrl)"],
  ];
  const missing = REQUIRED.filter(([key]) => !cfg[key]);
  if (missing.length) {
    const banner = $("setup-banner");
    banner.classList.remove("hidden");
    const list = document.createElement("p");
    list.className = "banner-missing";
    list.textContent = "Missing: " + missing.map(([, label]) => label).join(", ") + ".";
    banner.appendChild(list);
  }

  $("btn-azure").addEventListener("click", onAzureAuth);
  $("btn-github").addEventListener("click", onGithubAuth);
  $("repo-form").addEventListener("submit", onAnalyze);
  $("repo-input").addEventListener("input", onRepoInput);
  $("btn-whatif").addEventListener("click", onWhatIf);
  $("btn-apply").addEventListener("click", onApply);
  $("btn-ship").addEventListener("click", onShip);
  $("go-codify").addEventListener("click", () => goToStage("codify"));
  $("go-deploy").addEventListener("click", () => goToStage("deploy"));

  // Stepper + back buttons: any element with data-stage navigates.
  for (const el of document.querySelectorAll("[data-stage]")) {
    el.addEventListener("click", () => goToStage(el.dataset.stage));
  }

  // Deploy inputs: changing them invalidates a prior what-if and marks dirty.
  for (const id of ["sub-select", "rg-input", "region-input", "pg-password"]) {
    $(id).addEventListener("input", () => {
      if (id === "rg-input") dirty.rg = true;
      if (id === "region-input") dirty.region = true;
      deployInputRevision++;
      setWhatIfOk(false);
    });
  }
  $("ship-repo-input").addEventListener("input", () => {
    dirty.ship = true;
  });
  $("confirm-assumptions").addEventListener("change", (event) => {
    confirmationApprovalSequence = event.target.checked ? analysisSequence : -1;
    deployInputRevision++;
    setWhatIfOk(false);
    updateAvailability();
  });

  // Deep-link support: #review / #codify / #deploy on boot (guarded).
  const hash = location.hash.replace(/^#/, "");
  if (STAGES.includes(hash)) currentStage = hash;
  render();

  // Restore any prior sign-ins (redirect return or a saved tab session).
  restoreSessions(oauthResult);
}

// --------------------------------------------------------------------------
// Stage state machine
// --------------------------------------------------------------------------

/** Navigate to a stage. `act` resolves to the last-chosen spoke. Guards gate. */
function goToStage(stage) {
  if (stage === "act") stage = lastAct;
  if (!STAGES.includes(stage)) return;
  // Every stage past source requires an analyzed repo.
  if (stage !== "source" && !current) return;
  if (stage === "codify" || stage === "deploy") lastAct = stage;
  currentStage = stage;
  history.replaceState(null, "", `#${stage}`);
  render();
}

/** Single render: show exactly one stage, sync stepper, rails, and availability. */
function render() {
  for (const s of STAGES) $(`stage-${s}`).classList.toggle("hidden", s !== currentStage);
  updateStepper();
  updateRails();
  updateAvailability();
}

function updateStepper() {
  const group = currentStage === "codify" || currentStage === "deploy" ? "act" : currentStage;
  for (const item of document.querySelectorAll("#stepper .stepper-item")) {
    const s = item.dataset.stage;
    item.classList.toggle("active", s === group);
    // Review/Act are unreachable until a repo is analyzed.
    item.disabled = (s === "review" || s === "act") && !current;
  }
}

function updateRails() {
  if (!current) return;
  const p = current.plan;
  const cost = p.budget ? `~$${p.budget.estimatedMonthlyUsd}/mo` : "cost n/a";
  const html =
    `<span class="rail-app">${esc(current.appName)}</span>` +
    `<span class="rail-sep">·</span>${p.resources.length} resource(s)` +
    `<span class="rail-sep">·</span>${esc(cost)}` +
    `<span class="rail-sep">·</span>${esc(p.region)}`;
  $("rail-codify").innerHTML = html;
  $("rail-deploy").innerHTML = html;
}

function setDot(btnId, state) {
  $(btnId).querySelector(".dot").dataset.state = state;
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

async function onAzureAuth() {
  if (azureSignedIn()) {
    try {
      await azureSignOut();
    } catch (err) {
      console.warn("Azure provider sign-out did not complete:", err.message);
    } finally {
      setDot("btn-azure", "out");
      $("btn-azure").lastChild.textContent = " Sign in with Azure";
      $("sub-select").replaceChildren();
      $("sub-select").disabled = true;
      deployInputRevision++;
      setWhatIfOk(false);
      clearAuthNotice();
      render();
    }
    return;
  }
  setDot("btn-azure", "pending");
  try {
    const acct = await azureSignIn(cfg);
    applyAzureSignedIn(acct);
    await populateSubscriptions();
    render();
  } catch (err) {
    if (err?.redirecting) return; // navigating away to finish sign-in
    setDot("btn-azure", "out");
    renderAzureError(err);
  }
}

/** Reflect a signed-in Azure account in the button + notice. */
function applyAzureSignedIn(acct) {
  setDot("btn-azure", "in");
  $("btn-azure").lastChild.textContent = ` ${acct.username || "Signed in"}`;
  clearAuthNotice();
}

/**
 * Restore prior sign-ins on page load. Handles redirect-flow returns for both
 * providers, then falls back to a saved tab session (GitHub) or MSAL's cached
 * account (Azure). Sets each button straight to its final state — no "pending"
 * flicker on loads where there's nothing to restore.
 */
async function restoreSessions(oauthResult) {
  try {
    let ghUser = await handleGithubRedirect(oauthResult);
    if (!ghUser) ghUser = await restoreGithubSession();
    if (ghUser) {
      setDot("btn-github", "in");
      $("btn-github").lastChild.textContent = ` ${ghUser.login}`;
      loadRepoChoices();
    }
  } catch (err) {
    if (!err?.redirecting) console.warn("GitHub session restore:", err.message);
  }

  try {
    const acct = await restoreAzureSession(cfg);
    if (acct) {
      applyAzureSignedIn(acct);
      await populateSubscriptions();
    }
  } catch (err) {
    if (err?.redirecting) return; // navigating away for the next redirect leg
    renderAzureError(err);
  }

  render();
}

function clearAuthNotice() {
  const el = $("auth-notice");
  el.classList.add("hidden");
  el.textContent = "";
}

/**
 * Render an Azure sign-in error into the auth-notice banner. When the tenant
 * gates the app behind admin approval (err.adminConsent), surface a one-click
 * admin-consent deep link instead of a dead-end alert. The URL is built by
 * azure.js from our own public client id + origin; nodes use the DOM API so no
 * user-controlled text is ever interpolated into HTML.
 */
function renderAzureError(err) {
  const el = $("auth-notice");
  el.classList.remove("hidden");
  el.textContent = "";
  const ac = err.adminConsent;
  if (err.needsAzureSignup) {
    const strong = document.createElement("strong");
    strong.textContent = "No Azure subscription on this account. ";
    el.append(strong);
    el.append(
      document.createTextNode(
        "This tool deploys to Azure, so you need an account that has an Azure subscription. Personal Microsoft accounts are welcome — create a free Azure account (it sets up your Azure directory), then sign in again: ",
      ),
    );
    const a = document.createElement("a");
    a.href = err.needsAzureSignup.signupUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Create a free Azure account ↗";
    el.append(a);
    el.append(
      document.createTextNode(
        " Already have a subscription? Sign in and pick the organization/directory that holds it.",
      ),
    );
    return;
  }
  if (!ac) {
    el.textContent = `Azure sign-in failed: ${err.message}`;
    return;
  }
  const strong = document.createElement("strong");
  strong.textContent = "Admin approval needed. ";
  el.append(strong);
  el.append(
    document.createTextNode(
      "Your organization requires an administrator to approve this app before you can sign in. Send an admin this one-click approval link: ",
    ),
  );
  const a = document.createElement("a");
  a.href = ac.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "Grant admin consent for your tenant ↗";
  el.append(a);
  el.append(
    document.createTextNode(
      " An admin approves once for the whole tenant; after that, sign in again here.",
    ),
  );
}

async function onGithubAuth() {
  if (githubSignedIn()) {
    githubSignOut();
    setDot("btn-github", "out");
    $("btn-github").lastChild.textContent = " Sign in with GitHub";
    repoChoices.clear();
    renderRepoOptions();
    $("repo-input").placeholder = "owner/repo  (sign in to search your repos)";
    render();
    return;
  }
  setDot("btn-github", "pending");
  try {
    const user = await githubSignIn(cfg);
    setDot("btn-github", "in");
    $("btn-github").lastChild.textContent = ` ${user.login}`;
    render();
    loadRepoChoices();
  } catch (err) {
    if (err?.redirecting) return; // navigating away to GitHub
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

  analysisController?.abort();
  analysisController = new AbortController();
  const sequence = ++analysisSequence;
  current = null;
  confirmationApprovalSequence = -1;
  deployInputRevision++;
  setWhatIfOk(false);
  if (currentStage !== "source") goToStage("source");
  else render();
  const status = $("repo-status");
  status.className = "status";
  status.textContent = "Fetching repo files…";
  try {
    const { owner, repo, files, truncated } = await fetchRepoFiles(ownerRepo, ref, {
      signal: analysisController.signal,
    });
    if (sequence !== analysisSequence) return;
    if (files.size === 0) throw new Error("No readable text files found in that repo/branch.");
    if (truncated) {
      throw new Error(
        "Repository scan was incomplete (GitHub truncated the tree or the 400-file safety cap was reached). Deployment is disabled; narrow the repository or branch and analyze again.",
      );
    }
    status.textContent = `Scanned ${files.size} files. Resolving plan…`;

    const result = resolveScan(repo, files);
    if (sequence !== analysisSequence) return;
    current = { ...result, appName: repo, owner, hosting: detectCurrentHosting(files) };
    renderReview(current);
    resetActionState(owner, repo, result.plan);

    status.className = "status ok";
    status.textContent = `Done — ${result.plan.resources.length} Azure resource(s) planned for “${repo}”.`;
    goToStage("review");
  } catch (err) {
    if (sequence !== analysisSequence || err?.name === "AbortError") return;
    status.className = "status err";
    renderRepoError(status, err);
  }
}

/**
 * Re-prime action inputs for a freshly analyzed repo. Clears both logs, resets
 * the what-if gate, wipes the PG secret, and re-seeds rg/region/ship defaults —
 * but only for fields the user hasn't hand-edited (tracked via `dirty`). A new
 * analyze is a new plan, so we clear `dirty` first and let the plan re-seed.
 */
function resetActionState(owner, repo, plan) {
  dirty.rg = dirty.region = dirty.ship = false;
  $("deploy-log").textContent = "";
  $("ship-log").textContent = "";
  const pg = $("pg-password");
  if (pg) pg.value = "";
  $("rg-input").value = `rg-${slug(repo)}`;
  $("region-input").value = plan.region;
  // Default the new-repo name to the SOURCE repo's owner path, so an org-owned
  // app lands its infra in the same org (e.g. `my-org/app-infra`) rather than
  // silently under the signed-in personal account. Users can edit it.
  $("ship-repo-input").value = owner ? `${owner}/${slug(repo)}-infra` : `${slug(repo)}-infra`;
  whatIfOk = false;
  approvedInputRevision = -1;
  deployInputRevision++;
}

/**
 * Heuristic "this app already runs somewhere" detector over the fetched file
 * map, used for the migration note. Returns human-readable host labels. Pure
 * client-side lookup — no engine change needed.
 */
function detectCurrentHosting(files) {
  const has = (p) => files.has(p);
  const hasPrefix = (pre) => [...files.keys()].some((k) => k.startsWith(pre));
  const hasBase = (name) => [...files.keys()].some((k) => k.split("/").pop() === name);
  const labels = [];
  if (hasBase("Dockerfile") || [...files.keys()].some((k) => k.split("/").pop().startsWith("Dockerfile")))
    labels.push("a container image (Dockerfile)");
  if (hasPrefix(".github/workflows/")) labels.push("GitHub Actions CI");
  if (has("vercel.json")) labels.push("Vercel");
  if (has("netlify.toml")) labels.push("Netlify");
  if (has("Procfile") || has("app.json")) labels.push("Heroku");
  if (has("fly.toml")) labels.push("Fly.io");
  if (has("render.yaml")) labels.push("Render");
  if (has("app.yaml")) labels.push("Google App Engine / App Platform");
  if (has("azure.yaml") || has("azure.yml")) labels.push("Azure Developer CLI (azd)");
  return labels;
}

/**
 * Render an analyze error into the status line. For GitHub's org OAuth-App
 * restriction 403, swap the raw message for a short explanation plus a one-click
 * "Grant access" deep-link to the org's OAuth App policy page (opens in a new
 * tab). Nodes are built with the DOM API so the org name is never interpolated
 * into HTML. Everything else falls back to plain text.
 */
function renderRepoError(status, err) {
  const r = err.orgRestriction;
  if (!r) {
    status.textContent = err.message;
    return;
  }
  status.textContent = "";
  status.append(
    document.createTextNode(
      `The “${r.org}” org restricts third-party OAuth Apps, so this app can't read its repos yet. An org owner can grant access here: `,
    ),
  );
  const a = document.createElement("a");
  a.href = r.grantUrl;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = `Grant this app access to ${r.org} ↗`;
  status.append(a);
  status.append(
    document.createTextNode(
      " After granting, sign out and sign back in with GitHub, then retry.",
    ),
  );
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

function renderReview(r) {
  renderMigrationNote(r.hosting);
  renderWhy(r.intent);
  renderWhat(r.plan);
  renderConfirmationGate(r.plan);
  renderScaffold(r.scaffold);
  $("land-count").textContent = String(r.scaffold.length);
  $("bicep-view").textContent = r.bicep;
}

function renderConfirmationGate(plan) {
  const gate = $("confirmation-gate");
  const list = $("confirmation-list");
  const checkbox = $("confirm-assumptions");
  const confirmations = plan.confirmations?.filter((confirmation) => confirmation.confidence !== "high") || [];
  const requiredDecisions = confirmations.filter((confirmation) => !confirmation.assumption);
  list.textContent = "";
  checkbox.checked = confirmationApprovalSequence === analysisSequence;
  checkbox.disabled = requiredDecisions.length > 0;
  gate.classList.toggle("hidden", confirmations.length === 0);
  for (const confirmation of confirmations) {
    const item = document.createElement("li");
    const details = [confirmation.why];
    if (confirmation.options?.length) details.push(`Options: ${confirmation.options.join(" / ")}`);
    details.push(
      confirmation.assumption
        ? `Assumption: ${confirmation.assumption}`
        : "Decision required: update the source configuration or guardrails, then analyze again.",
    );
    item.textContent = `${confirmation.question} (${details.join(" ")})`;
    list.appendChild(item);
  }
}

function renderMigrationNote(hosting) {
  const el = $("migration-note");
  if (!hosting || hosting.length === 0) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.textContent = "";
  const strong = document.createElement("strong");
  strong.textContent = "Heads up — this app already deploys somewhere. ";
  el.append(strong);
  el.append(
    document.createTextNode(
      `Signals detected: ${hosting.join(", ")}. Landing this infra points it at Azure ` +
        "(Container Apps) instead, so treat it as a migration — review the plan before it goes live.",
    ),
  );
}

/** Consolidated "Why" — the app plus its inferred capability needs. */
function renderWhy(intent) {
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
  $("why-view").innerHTML =
    `<div class="card"><h3>${esc(app.name || "app")}</h3>
     <div class="hint">${esc(app.language || "")} ${esc(app.framework || "")}</div></div>` +
    (rows || `<p class="hint">No capabilities inferred.</p>`);
}

/** Consolidated "What & cost" — the resources plus the budget summary. */
function renderWhat(plan) {
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
  $("what-view").innerHTML =
    budget +
    (summary ? `<div class="card"><h3>Summary</h3><div class="hint">${summary}</div></div>` : "") +
    rows;
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

/**
 * Central availability + reason engine. Computes disabled state and the
 * co-located "why" for both act spokes and the review chooser cards. Buttons
 * that navigate stay enabled; only terminal actions gate on auth/inputs.
 */
function updateAvailability() {
  const unresolved = unresolvedConfirmations();
  const confirmationReason = unresolved.length
    ? `Resolve ${unresolved.length} confirmation${unresolved.length === 1 ? "" : "s"} before acting.`
    : "";
  // Codify path.
  const codifyReason = !current
    ? "Analyze a repo first."
    : !githubSignedIn()
      ? "Sign in with GitHub (top bar) to enable."
      : confirmationReason;
  $("btn-ship").disabled = Boolean(codifyReason);
  setReason("codify-reason", codifyReason, "review");
  setReason("codify-reason-act", codifyReason, "act");

  // Deploy path.
  const subVal = $("sub-select").value;
  const noSubs = azureSignedIn() && $("sub-select").options.length === 0;
  const budgetBlocked = Boolean(current?.plan?.budget?.blocked);
  let deployReason = "";
  if (!current) deployReason = "Analyze a repo first.";
  else if (!azureSignedIn()) deployReason = "Sign in with Azure (top bar) to enable.";
  else if (noSubs) deployReason = "Signed in, but no Azure subscriptions were found on this account.";
  else if (!subVal) deployReason = "Pick a subscription.";
  else if (budgetBlocked) deployReason = "A guardrail blocks this plan's budget — deploy is disabled.";
  else if (confirmationReason) deployReason = confirmationReason;
  setReason("deploy-reason", deployReason, "review");
  setReason("deploy-reason-act", deployReason, "act");

  const canWhatIf =
    Boolean(current) && azureSignedIn() && Boolean(subVal) && !budgetBlocked && unresolved.length === 0;
  $("btn-whatif").disabled = !canWhatIf;
  $("btn-apply").disabled = !canWhatIf || !whatIfOk;

  // Show the PG password field only when the plan provisions Postgres.
  const pgField = $("pg-field");
  if (pgField) pgField.classList.toggle("hidden", !(current && planNeedsPgPassword(current.plan)));
}

function unresolvedConfirmations() {
  const confirmations =
    current?.plan?.confirmations?.filter((confirmation) => confirmation.confidence !== "high") || [];
  return confirmations.filter(
    (confirmation) => !confirmation.assumption || confirmationApprovalSequence !== analysisSequence,
  );
}

function requireResolvedConfirmations() {
  const unresolved = unresolvedConfirmations();
  if (unresolved.length) {
    throw new Error(
      `Refusing to act with ${unresolved.length} unresolved confirmation(s): ` +
        unresolved.map((confirmation) => confirmation.id).join(", "),
    );
  }
}

/**
 * Fill a reason element. `scope` "review" hides the note when empty (the card's
 * static hint already explains the happy path); "act" shows a positive "Ready"
 * so the user isn't left wondering.
 */
function setReason(id, msg, scope) {
  const el = $(id);
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.remove("hidden", "ok");
    el.classList.add("warn");
  } else if (scope === "act") {
    el.textContent = "Ready.";
    el.classList.remove("hidden", "warn");
    el.classList.add("ok");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

function setWhatIfOk(ok) {
  whatIfOk = ok;
  approvedInputRevision = ok ? deployInputRevision : -1;
  updateAvailability();
}

/** Collect deploy parameters, reading the masked PG password field once. */
function deployParameters() {
  const params = {};
  if (planNeedsPgPassword(current.plan)) {
    const pw = $("pg-password").value;
    if (!pw) throw new Error("Enter the PostgreSQL admin password (field above) to deploy this plan.");
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
    requireResolvedConfirmations();
    const inputRevision = deployInputRevision;
    const { subscriptionId, resourceGroup, region } = deployInputs();
    const params = deployParameters();
    const template = generateArmTemplate(current.plan);

    const write = (m) => (log.textContent += m + "\n");
    const exists = await resourceGroupExists(subscriptionId, resourceGroup);
    if (inputRevision !== deployInputRevision) {
      throw new Error("Deployment inputs changed while preparing what-if. Run what-if again.");
    }
    if (!exists) {
      const approved = window.confirm(
        `ARM what-if requires resource group “${resourceGroup}” to exist.\n\n` +
          `Create it in ${region} now? This is a real Azure change; no app resources are deployed yet.`,
      );
      if (!approved) {
        write("Preview canceled; Azure was not changed.");
        return;
      }
      write(`▶ Creating prerequisite resource group ${resourceGroup} (${region}) — real Azure change…`);
      await ensureResourceGroup(subscriptionId, resourceGroup, region);
      if (inputRevision !== deployInputRevision) {
        throw new Error("Deployment inputs changed. The prerequisite group was created, but what-if was not run.");
      }
    }
    write("▶ Running ARM what-if (no application resources changed)…");
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
    if (inputRevision !== deployInputRevision) {
      throw new Error("Deployment inputs changed while what-if was running. Run what-if again.");
    }
    setWhatIfOk(true);
  } catch (err) {
    $("deploy-log").textContent += `\n✖ ${err.message}\n`;
    setWhatIfOk(false);
  }
}

async function onApply() {
  if (!whatIfOk || approvedInputRevision !== deployInputRevision) return;
  const log = $("deploy-log");
  const write = (m) => (log.textContent += m + "\n");
  let inputs;
  try {
    requireResolvedConfirmations();
    inputs = deployInputs();
  } catch (err) {
    write(`\n✖ ${err.message}`);
    return;
  }
  const sel = $("sub-select");
  const subName = sel.options[sel.selectedIndex]?.textContent || inputs.subscriptionId;
  const count = current.plan.resources.length;
  const cost = current.plan.budget ? `~$${current.plan.budget.estimatedMonthlyUsd}/mo` : "unknown cost";
  const confirmed = window.confirm(
    `Deploy ${count} resource(s) to:\n` +
      `  subscription: ${subName}\n` +
      `  resource group: ${inputs.resourceGroup} (${inputs.region})\n` +
      `  estimated: ${cost}\n\n` +
      "This creates real Azure resources and will incur cost. Continue?",
  );
  if (!confirmed) return;
  try {
    const { subscriptionId, resourceGroup, region } = inputs;
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
    requireResolvedConfirmations();
    const name = $("ship-repo-input").value.trim();
    if (!name) throw new Error("Enter a name for the new repo.");
    const isPrivate = $("ship-private").checked;
    const files = current.scaffold.map((f) => ({ path: f.path, contents: f.content }));
    write(`▶ Creating ${isPrivate ? "private " : ""}repo “${name}”, committing ${files.length} files, and opening a PR…`);
    const res = await createRepoAndPush(
      name,
      isPrivate,
      files,
      `azx: infra scaffold for ${current.appName}`,
    );
    write(`\n✔ Repo created: ${res.htmlUrl}`);
    write(`✔ Pull request opened: ${res.prUrl}`);
    write(`\n  Review the PR, then merge to land the infra on ${res.base}.`);
    write("  After merging: add AZURE_CLIENT_ID / TENANT_ID / SUBSCRIPTION_ID repo variables and");
    write("  run setup-azure-oidc.sh so the committed pipeline can deploy via OIDC.");
  } catch (err) {
    const r = err.orgRestriction;
    if (r) {
      log.append(
        document.createTextNode(
          `\n✖ The “${r.org}” org restricts third-party OAuth Apps, so this app can't create the repo there yet. An org owner can grant access here: `,
        ),
      );
      const a = document.createElement("a");
      a.href = r.grantUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `Grant this app access to ${r.org} ↗`;
      log.append(a);
      log.append(
        document.createTextNode(
          " After granting, sign out and sign back in with GitHub, then retry.\n",
        ),
      );
    } else {
      write(`\n✖ ${err.message}`);
    }
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
