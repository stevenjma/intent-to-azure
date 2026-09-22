/**
 * app.js — SPA orchestration: GitHub auth, repo analysis, rendering, and PR handoff.
 *
 * The engine (scan → intent → plan → bicep → scaffold) runs entirely in this page.
 * GitHub I/O lives in github.js. This file is glue + rendering only; it never
 * persists tokens.
 */

import { resolveScan } from "./engine/web-engine.js?v=20260917a";
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
  orgGrantUrl,
  searchRepos,
} from "./github.js?v=20260917a";
import {
  initializeTelemetry,
  setTelemetryEnabled,
  telemetryState,
  trackEvent,
} from "./telemetry.js?v=20260917a";

const cfg = window.AZX_CONFIG || {};
const $ = (id) => document.getElementById(id);

/** Current analysis result: { intent, plan, bicep, scaffold, appName, hosting }. */
let current = null;
let analysisSequence = 0;
let analysisController = null;
let confirmationApprovalSequence = -1;

const STAGES = ["source", "review", "codify"];
/** The stage currently shown (exactly one `#stage-*` is visible at a time). */
let currentStage = "source";
/** Tracks fields the user has hand-edited so a re-analyze won't clobber them. */
const dirty = { ship: false };

// --------------------------------------------------------------------------
// Setup / boot
// --------------------------------------------------------------------------

export function boot(oauthResult = null) {
  initializeTelemetry(cfg).then(updateTelemetryDisclosure);
  trackEvent("page_loaded", { stage: currentStage });
  // Name every required identifier so the setup banner can say exactly what's
  // missing (self-host forkers hit partial-config states otherwise — DR-010).
  const REQUIRED = [
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

  $("btn-github").addEventListener("click", onGithubAuth);
  $("repo-form").addEventListener("submit", onAnalyze);
  $("repo-input").addEventListener("input", onRepoInput);
  $("btn-ship").addEventListener("click", onShip);
  $("go-codify").addEventListener("click", () => goToStage("codify"));

  // Stepper + back buttons: any element with data-stage navigates.
  for (const el of document.querySelectorAll("[data-stage]")) {
    el.addEventListener("click", () => goToStage(el.dataset.stage));
  }

  $("ship-repo-input").addEventListener("input", () => {
    dirty.ship = true;
  });
  $("confirm-assumptions").addEventListener("change", (event) => {
    confirmationApprovalSequence = event.target.checked ? analysisSequence : -1;
    if (event.target.checked) {
      trackEvent("assumptions_confirmed", { stage: "review" }, {
        confirmationCount: current?.plan?.confirmations?.length || 0,
      });
    }
    updateAvailability();
  });
  $("telemetry-toggle").addEventListener("click", () => {
    setTelemetryEnabled(!telemetryState().enabled);
  });

  // Deep-link support: #review / #codify on boot (guarded).
  const hash = location.hash.replace(/^#/, "");
  if (STAGES.includes(hash)) currentStage = hash;
  render();

  // Restore any prior sign-ins (redirect return or a saved tab session).
  restoreSessions(oauthResult);
}

// --------------------------------------------------------------------------
// Stage state machine
// --------------------------------------------------------------------------

/** Navigate to a stage. `act` resolves to the single PR handoff. */
function goToStage(stage) {
  if (stage === "act") stage = "codify";
  if (!STAGES.includes(stage)) return;
  // Every stage past source requires an analyzed repo.
  if (stage !== "source" && !current) return;
  currentStage = stage;
  if (stage === "codify") trackEvent("codify_viewed", { stage });
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
  const group = currentStage === "codify" ? "act" : currentStage;
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
}

function setDot(btnId, state) {
  $(btnId).querySelector(".dot").dataset.state = state;
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

/**
 * Restore GitHub sign-in on page load from a redirect return or saved tab session.
 */
async function restoreSessions(oauthResult) {
  try {
    let ghUser = await handleGithubRedirect(oauthResult);
    if (!ghUser) ghUser = await restoreGithubSession();
    if (ghUser) {
      trackEvent(oauthResult?.token ? "github_auth_succeeded" : "github_auth_restored", {
        stage: currentStage,
      });
      setDot("btn-github", "in");
      $("btn-github").lastChild.textContent = ` ${ghUser.login}`;
      loadRepoChoices();
    }
  } catch (err) {
    trackEvent("github_auth_failed", { stage: currentStage, errorCode: classifyError(err) });
    if (!err?.redirecting) console.warn("GitHub session restore:", err.message);
  }

  render();
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
    trackEvent("github_auth_succeeded", { stage: currentStage });
    setDot("btn-github", "in");
    $("btn-github").lastChild.textContent = ` ${user.login}`;
    render();
    loadRepoChoices();
  } catch (err) {
    if (err?.redirecting) return; // navigating away to GitHub
    setDot("btn-github", "out");
    trackEvent("github_auth_failed", { stage: currentStage, errorCode: classifyError(err) });
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
  const startedAt = performance.now();
  trackEvent("analysis_started", { stage: "source" });
  current = null;
  confirmationApprovalSequence = -1;
  if (currentStage !== "source") goToStage("source");
  else render();
  const status = $("repo-status");
  status.className = "status";
  status.textContent = "Fetching repo files…";
  try {
    const { owner, repo, files, commitSha, truncated } = await fetchRepoFiles(ownerRepo, ref, {
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

    const result = resolveScan(repo, files, {
      scaffold: { sourceRepository: `${owner}/${repo}`, sourceRef: commitSha, sourcePath: "." },
    });
    if (sequence !== analysisSequence) return;
    current = {
      ...result,
      appName: repo,
      owner,
      repo,
      files,
      commitSha,
      hosting: detectCurrentHosting(files),
    };
    renderReview(current);
    resetActionState(owner, repo);

    status.className = "status ok";
    status.textContent = `Done — ${result.plan.resources.length} Azure resource(s) planned for “${repo}”.`;
    trackEvent(
      "analysis_succeeded",
      {
        stage: "review",
        framework: result.intent.app.framework || "unknown",
        hosting: result.intent.needs.some((need) => need.capability === "static-hostable-frontend")
          ? "static"
          : "server",
      },
      {
        durationMs: performance.now() - startedAt,
        fileCount: files.size,
        resourceCount: result.plan.resources.length,
        confirmationCount: result.plan.confirmations?.length || 0,
      },
    );
    goToStage("review");
  } catch (err) {
    if (sequence !== analysisSequence || err?.name === "AbortError") return;
    status.className = "status err";
    renderRepoError(status, err);
    trackEvent(
      "analysis_failed",
      { stage: "source", errorCode: classifyError(err) },
      { durationMs: performance.now() - startedAt },
    );
  }
}

/**
 * Re-prime the PR handoff for a freshly analyzed repo.
 */
function resetActionState(owner, repo) {
  dirty.ship = false;
  $("ship-log").textContent = "";
  // Default the new-repo name to the SOURCE repo's owner path, so an org-owned
  // app lands its infra in the same org (e.g. `my-org/app-infra`) rather than
  // silently under the signed-in personal account. Users can edit it.
  $("ship-repo-input").value = owner ? `${owner}/${slug(repo)}-infra` : `${slug(repo)}-infra`;
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
  a.href = orgGrantUrl(r.org);
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
  const requiredDecisions = confirmations.filter(
    (confirmation) => !confirmation.assumption || confirmation.id === "hosting:static-export",
  );
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
    if (confirmation.id === "hosting:static-export") {
      const choice = document.createElement("select");
      choice.setAttribute("aria-label", "Hosting class");
      for (const [value, label] of [
        ["", "Choose hosting class"],
        ["static", "Static-compatible routing"],
        ["server", "Requires runtime request handling"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        choice.appendChild(option);
      }
      choice.addEventListener("change", () => {
        if (choice.value) applyHostingOverride(choice.value);
      });
      item.append(" ", choice);
    }
    list.appendChild(item);
  }
}

function applyHostingOverride(hostingOverride) {
  if (!current || (hostingOverride !== "static" && hostingOverride !== "server")) return;
  analysisSequence += 1;
  confirmationApprovalSequence = -1;
  const result = resolveScan(current.repo, current.files, {
    hostingOverride,
    scaffold: {
      sourceRepository: `${current.owner}/${current.repo}`,
      sourceRef: current.commitSha,
      sourcePath: ".",
    },
  });
  current = { ...current, ...result, hostingOverride };
  renderReview(current);
  updateAvailability();
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

/**
 * Central availability + reason engine for the PR handoff.
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

// --------------------------------------------------------------------------
// Ship (codify as a repo)
// --------------------------------------------------------------------------

async function onShip() {
  const log = $("ship-log");
  const write = (m) => (log.textContent += m + "\n");
  log.textContent = "";
  const startedAt = performance.now();
  try {
    requireResolvedConfirmations();
    const name = $("ship-repo-input").value.trim();
    if (!name) throw new Error("Enter a name for the new repo.");
    const isPrivate = $("ship-private").checked;
    trackEvent("pr_create_started", { stage: "codify" });
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
    trackEvent("pr_created", { stage: "codify" }, { durationMs: performance.now() - startedAt });
    write("\n  Nothing has deployed. Review and share the PR.");
    write("  Follow its README to connect Azure once. Merge to run what-if; deploy later with a manual workflow run.");
  } catch (err) {
    trackEvent(
      "pr_create_failed",
      { stage: "codify", errorCode: classifyError(err) },
      { durationMs: performance.now() - startedAt },
    );
    const r = err.orgRestriction;
    if (r) {
      log.append(
        document.createTextNode(
          `\n✖ The “${r.org}” org restricts third-party OAuth Apps, so this app can't create the repo there yet. An org owner can grant access here: `,
        ),
      );
      const a = document.createElement("a");
      a.href = orgGrantUrl(r.org);
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

function updateTelemetryDisclosure() {
  const state = telemetryState();
  const disclosure = $("telemetry-disclosure");
  disclosure.classList.toggle("hidden", !state.configured);
  if (!state.configured) return;
  const toggle = $("telemetry-toggle");
  if (state.doNotTrack) {
    toggle.textContent = "Disabled by browser privacy setting.";
    toggle.disabled = true;
  } else {
    toggle.textContent = state.enabled ? "Turn off telemetry" : "Turn on telemetry";
    toggle.disabled = false;
  }
}

function classifyError(error) {
  const message = String(error?.message || "");
  if (error?.orgRestriction) return "github_org_restricted";
  if (/incomplete|truncated|safety cap/i.test(message)) return "scan_incomplete";
  if (/No readable text files/i.test(message)) return "no_readable_files";
  if (/confirmation/i.test(message)) return "unresolved_confirmation";
  if (/OAuth state/i.test(message)) return "oauth_state";
  if (/sign-in|GitHub/i.test(message)) return "github_request";
  return "unknown";
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
