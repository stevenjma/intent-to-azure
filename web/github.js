/**
 * github.js — GitHub connect + repo I/O for the SPA, over plain fetch (no SDK).
 *
 * OAuth: a static page can't do the code→token exchange (needs the client secret +
 * the token endpoint is CORS-blocked), so we bounce through a tiny token-exchange
 * Worker (see web/worker/). The Worker holds the secret, does the exchange, and
 * redirects the token to the exact app path. A local bootstrap validates and strips
 * the fragment before this module or any third-party module loads.
 *
 * Repo read: enumerate the git tree, pull text blobs into a Map<path, contents> —
 * the exact shape the browser engine's scanFileMap() consumes.
 *
 * Repo write (ship): create a repo, seed it through the Contents API, create a
 * feature ref, then add each scaffold file through the Contents API. No local git.
 */

const API = "https://api.github.com";

// Mirror the CLI's read-repo caps so browser scans match disk scans in spirit.
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", ".rb", ".go",
  ".rs", ".java", ".cs", ".php", ".yaml", ".yml", ".toml", ".txt",
  ".md", ".lock", ".sh", ".dockerfile", ".prisma", ".sql", ".html", ".css",
]);
const INTERESTING = new Set([
  "package.json", "package-lock.json", "requirements.txt", "pyproject.toml",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".env.example",
  "next.config.js", "next.config.mjs", "go.mod", "Gemfile", "pom.xml",
]);
const MAX_FILE_BYTES = 1_500_000;
const MAX_BLOB_FETCHES = 400;

/** Runtime token + user; credentials intentionally remain memory-only. */
let token = null;
let user = null;

export function githubToken() {
  return token;
}
export function githubUser() {
  return user;
}
export function githubSignedIn() {
  return token != null;
}

/** Inject auth for Node-based live repros without duplicating the shipped flow. */
export function __setAuth(authToken, authUser) {
  token = authToken;
  user = authUser;
}

// --------------------------------------------------------------------------
// OAuth redirect handling
// --------------------------------------------------------------------------

const OAUTH_STATE_KEY = "azx.gh.oauth_state";

/** URL-safe base64 (ASCII input — our own origin+path). */
function b64urlEncode(s) {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function restoreGithubSession() {
  return null;
}

/**
 * Complete a redirect-based GitHub sign-in from the bootstrap's validated,
 * already-removed fragment payload. No-op when no OAuth result is pending.
 */
export async function handleGithubRedirect(result) {
  if (!result) return null;
  if (result.error) throw new Error(`GitHub sign-in failed: ${result.error}`);
  if (!result.token) return null;
  token = result.token;
  user = await gh("/user");
  return user;
}

function ext(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.toLowerCase() === "dockerfile") return ".dockerfile";
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i).toLowerCase();
}

function wantFile(path, size) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (size > MAX_FILE_BYTES) return false;
  // Never download live dotenv files. Examples are intentionally retained as
  // schema/signals, but `.env`, `.env.local`, `.env.production`, etc. may be secrets.
  if (/^\.env(?:\.|$)/i.test(base) && !/^\.env\.example$/i.test(base)) return false;
  return INTERESTING.has(base) || TEXT_EXT.has(ext(path));
}

/**
 * Build the org-owner OAuth App policy page URL where an owner grants this app
 * access to a restricted org's data.
 */
export function orgGrantUrl(org) {
  return `https://github.com/organizations/${encodeURIComponent(org)}/settings/oauth_application_policy`;
}

/**
 * Detect GitHub's "OAuth App access restrictions" 403 and, if matched, return
 * `{ org, grantUrl }` so the UI can offer a one-click grant deep-link. GitHub
 * names the org in backticks in the message; fall back to the owner segment of
 * a `/repos/<owner>/…` request path.
 */
function orgRestriction(status, message, path) {
  if (status !== 403 || !/OAuth App access restrictions/i.test(message || "")) {
    return null;
  }
  let org = (message.match(/`([^`]+)`/) || [])[1];
  if (!org) {
    org = (path.match(/\/repos\/([^/]+)\//) || [])[1];
  }
  if (!org) return null;
  return { org, grantUrl: orgGrantUrl(org) };
}

async function gh(path, { method = "GET", body, raw = false, signal } = {}) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).message || "";
    } catch {
      /* ignore */
    }
    const err = new Error(`GitHub ${method} ${path} → ${res.status} ${detail}`.trim());
    err.status = res.status;
    const restriction = orgRestriction(res.status, detail, path);
    if (restriction) err.orgRestriction = restriction;
    throw err;
  }
  return raw ? res : res.json();
}

/**
 * Kick off GitHub OAuth as a full-page redirect. GitHub Pages project sites share
 * an origin, so popup postMessage delivery cannot distinguish this app from another
 * project under the same account. Redirect delivery lets the Worker enforce the
 * exact application path before placing the token in a URL fragment.
 */
export function githubSignIn(config) {
  return new Promise((resolve, reject) => {
    if (!config.githubWorkerUrl || !config.githubClientId) {
      reject(new Error("GitHub not configured (githubClientId / githubWorkerUrl)."));
      return;
    }
    const csrf = crypto.randomUUID();
    const scope = config.githubScopes || "repo workflow read:user";
    const base = config.githubWorkerUrl.replace(/\/$/, "");
    const returnUrl = new URL(".", window.location.href).href;
    const redirectState = `${csrf}.r.${b64urlEncode(returnUrl)}`;
    try {
      sessionStorage.setItem(OAUTH_STATE_KEY, redirectState);
    } catch {
      reject(new Error("GitHub sign-in requires sessionStorage for OAuth state validation."));
      return;
    }
    const loginUrl =
      `${base}/login?state=${encodeURIComponent(redirectState)}&scope=${encodeURIComponent(scope)}`;
    const redirecting = new Error("Redirecting to GitHub…");
    redirecting.redirecting = true;
    reject(redirecting);
    window.location.assign(loginUrl);
  });
}

export function githubSignOut() {
  token = null;
  user = null;
}

/**
 * List repositories the authenticated user can access — across their personal
 * account and any orgs where this OAuth App has been granted — most-recently
 * pushed first. Pages up to `maxPages`×100 results so the type-ahead has a
 * useful working set without unbounded API calls. Returns lightweight rows.
 */
export async function listAccessibleRepos(maxPages = 4) {
  if (!token) throw new Error("Sign in with GitHub first.");
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await gh(
      `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`,
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      out.push({
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: !!r.private,
        pushedAt: r.pushed_at,
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}

/**
 * Search repositories the user can reach by free-text, for queries beyond the
 * locally-cached page set. Scopes to repos owned by or visible to the user via
 * GitHub's search API. Returns the same lightweight row shape.
 */
export async function searchRepos(query) {
  if (!token) throw new Error("Sign in with GitHub first.");
  const q = query.trim();
  if (!q) return [];
  const login = (user && user.login) || (await gh("/user")).login;
  // `user:<login>` keeps results to repos the caller owns; the local list
  // already covers org/collaborator repos for the recent working set.
  const enc = encodeURIComponent(`${q} user:${login} fork:true`);
  const res = await gh(`/search/repositories?q=${enc}&per_page=20&sort=updated`);
  return (res.items || []).map((r) => ({
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: !!r.private,
    pushedAt: r.pushed_at,
  }));
}

/** Resolve `owner/repo` (+ optional ref) → { files: Map, defaultBranch, truncated }. */
export async function fetchRepoFiles(ownerRepo, ref, { signal } = {}) {
  const [owner, repo] = ownerRepo.split("/").map((s) => s.trim());
  if (!owner || !repo) throw new Error('Enter a repo as "owner/repo".');

  const meta = await gh(`/repos/${owner}/${repo}`, { signal });
  const branch = ref && ref.trim() ? ref.trim() : meta.default_branch;
  const branchInfo = await gh(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`, { signal });
  const treeSha = branchInfo.commit.commit.tree.sha;

  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`, { signal });
  const blobs = (tree.tree || []).filter(
    (n) => n.type === "blob" && wantFile(n.path, n.size ?? 0),
  );

  const files = new Map();
  let fetches = 0;
  let truncated = Boolean(tree.truncated);
  for (const node of blobs) {
    if (fetches >= MAX_BLOB_FETCHES) {
      truncated = true;
      break;
    }
    fetches++;
    const blob = await gh(`/repos/${owner}/${repo}/git/blobs/${node.sha}`, { signal });
    const contents =
      blob.encoding === "base64" ? decodeBase64Utf8(blob.content) : blob.content ?? "";
    files.set(node.path, contents);
  }
  return { owner, repo, files, defaultBranch: meta.default_branch, branch, truncated };
}

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Sleep helper. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry an operation while a just-created repo's git backend provisions.
 * Fresh repos can return 404 or 409 for tens of seconds after a successful
 * Contents API seed, so use bounded exponential backoff instead of a short
 * fixed-delay window. Other errors surface immediately.
 */
async function provisioningRetry(operation) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (err.status && err.status !== 404 && err.status !== 409) throw err;
      if (i < 7) await sleep(Math.min(500 * 2 ** i, 8_000));
    }
  }
  throw lastErr;
}

async function gitWrite(path, body, method = "POST") {
  return provisioningRetry(() => gh(path, { method, body }));
}

async function createBranchOrReuse(repoPath, branch, sha) {
  let lastErr;
  for (let i = 0; i < 8; i++) {
    try {
      await gh(`${repoPath}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${branch}`, sha },
      });
      return;
    } catch (err) {
      lastErr = err;
      if (err.status === 422) {
        try {
          // A retry continues from azx's existing branch. Never force-move a ref:
          // doing so can discard commits made after an earlier attempt.
          await gh(`${repoPath}/git/ref/heads/${branch}`);
          return;
        } catch (refErr) {
          if (refErr.status && refErr.status !== 404 && refErr.status !== 409) throw refErr;
        }
      } else if (err.status && err.status !== 404 && err.status !== 409) {
        throw err;
      }
      if (i < 7) await sleep(Math.min(500 * 2 ** i, 8_000));
    }
  }
  throw lastErr;
}

/**
 * PUT a file via the Contents API, retrying while the repo backend provisions.
 * The Contents API is the documented way to create the first commit in an empty
 * repo (it creates the branch + commit atomically), avoiding the git-data
 * "Git Repository is empty" 409 you hit writing blobs/trees to an unborn repo.
 */
async function contentsPut(path, body) {
  return provisioningRetry(() => gh(path, { method: "PUT", body }));
}

function encodeRepoPath(path) {
  return String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/**
 * Create a new repo and commit `scaffoldFiles` ([{ path, contents }]) onto an
 * `azx-infra` branch, then open a pull request into the repo's default branch so
 * the infra is reviewable before it lands.
 *
 * `repoName` may be either a bare `name` (created under the signed-in user) or an
 * `owner/name` where `owner` is a GitHub organization you can create repos in —
 * this is how you land the infra in an org path rather than your personal
 * account. Every git-data call uses the *created repo's* real owner/name from the
 * API response (not the raw input), so a sanitized name or org owner can't
 * produce a 404 against the wrong path.
 *
 * We deliberately do NOT use `auto_init`. The base commit and every scaffold
 * file are written through the Contents API, avoiding the independently
 * replicated git-data blob/tree/commit endpoints that can still report an empty
 * repository after the seed commit succeeds. Git-data is used only to create
 * the feature branch ref, with exponential retry while it becomes visible.
 *
 * The whole flow is idempotent: a prior failed run can leave behind an empty
 * repo the SPA can't delete (no `delete_repo` scope), so on a name-conflict 422
 * we reuse the existing repo, seed the base branch only if it's empty,
 * continue the existing `azx-infra` branch, and create-or-reuse the PR.
 *
 * Returns { htmlUrl, prUrl, owner, name, branch, base, login }.
 */
export async function createRepoAndPush(repoName, isPrivate, scaffoldFiles, commitMessage) {
  if (!token) throw new Error("Sign in with GitHub first.");
  const me = user || (await gh("/user"));

  // Split an optional `owner/` prefix. An owner that isn't the signed-in user is
  // treated as an organization and created via the orgs endpoint.
  const parts = String(repoName).split("/").map((s) => s.trim()).filter(Boolean);
  const rawName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const targetOwner = parts.length > 1 ? parts[0] : null;
  if (!rawName) throw new Error("Enter a name for the new repo.");

  const ownerPath = targetOwner || me.login;
  const createPath =
    targetOwner && targetOwner.toLowerCase() !== me.login.toLowerCase()
      ? `/orgs/${targetOwner}/repos`
      : "/user/repos";

  // Create the repo — but reuse it if it already exists. Every prior failed
  // Codify run can leave behind an empty repo (the create succeeds, a later
  // git-data write fails), and the SPA has no `delete_repo` scope to clean it
  // up. So on a name-conflict 422 we fetch the existing repo and continue
  // idempotently rather than dead-ending the user.
  const incompleteMarker = "azx-incomplete-repository-v1";
  let repo;
  let reused = false;
  try {
    repo = await gh(createPath, {
      method: "POST",
      body: {
        name: rawName,
        private: Boolean(isPrivate),
        auto_init: false,
        description: incompleteMarker,
      },
    });
  } catch (err) {
    if (err.status !== 422) throw err;
    const existing = await gh(`/repos/${ownerPath}/${rawName}`).catch(() => null);
    if (!existing) throw err; // 422 for some other reason (name policy, perms, quota).
    if (existing.description !== incompleteMarker) {
      throw new Error(
        `Repository ${ownerPath}/${rawName} already exists and was not created by an incomplete azx run. Choose a new name.`,
      );
    }
    repo = existing;
    reused = true;
  }
  // Always follow up against the repo's REAL owner/name, never the raw input.
  const owner = repo.owner.login;
  const name = repo.name;
  const base = repo.default_branch || "main";
  const R = `/repos/${owner}/${name}`;

  if (reused) {
    // The marker proves provenance; constrain its history to the branches azx
    // itself creates so a user-modified or unrelated repository is never reused.
    const branches = await gh(`${R}/branches?per_page=100`).catch((err) => {
      if (err.status === 409) return [];
      throw err;
    });
    if (branches.some((b) => b.name !== base && b.name !== "azx-infra")) {
      throw new Error(`Repository ${owner}/${name} is no longer an incomplete azx repository.`);
    }
    if (branches.some((b) => b.name === "azx-infra")) {
      const feature = await gh(`${R}/branches/azx-infra`);
      const tree = await gh(`${R}/git/trees/${feature.commit.commit.tree.sha}?recursive=1`);
      const allowedPaths = new Set(["README.md", ...scaffoldFiles.map((f) => String(f.path))]);
      if ((tree.tree || []).some((n) => n.type === "blob" && !allowedPaths.has(n.path))) {
        throw new Error(`Repository ${owner}/${name} contains files outside the incomplete azx scaffold.`);
      }
    }
  }

  // 1. Base branch: ensure the default branch has an initial commit. Reuse it if
  //    a prior run already seeded it; otherwise create it via the Contents API —
  //    the reliable way to write the first commit into an empty repo (branch +
  //    commit atomically), avoiding the git-data "Git Repository is empty" 409.
  let baseCommitSha = null;
  try {
    const ref = await gh(`${R}/git/ref/heads/${base}`);
    baseCommitSha = ref.object.sha;
  } catch (err) {
    if (err.status !== 404 && err.status !== 409) throw err; // empty repo → seed below.
  }
  const readme = `# ${name}\n\nAzure infrastructure generated by azx.\n`;
  if (baseCommitSha && reused) {
    const existingReadme = await gh(`${R}/contents/README.md?ref=${encodeURIComponent(base)}`).catch(
      () => null,
    );
    const contents =
      existingReadme?.encoding === "base64"
        ? decodeBase64Utf8(existingReadme.content)
        : existingReadme?.content;
    if (contents !== readme) {
      throw new Error(`Repository ${owner}/${name} default branch is not an azx seed.`);
    }
  }
  if (!baseCommitSha) {
    try {
      const seed = await contentsPut(`${R}/contents/README.md`, {
        message: "azx: initialize repository",
        content: encodeBase64Utf8(readme),
        branch: base,
      });
      baseCommitSha = seed.commit.sha;
    } catch (err) {
      if (err.status !== 422) throw err;
      // A rapid retry can observe the seed file before the git ref. Wait for
      // the already-created base ref rather than treating the conflict as fatal.
      const ref = await provisioningRetry(() => gh(`${R}/git/ref/heads/${base}`));
      baseCommitSha = ref.object.sha;
    }
  }

  // 2. Feature branch: create it from the base commit, or continue an existing
  //    branch from a positively identified incomplete run without moving its ref.
  const branch = "azx-infra";
  await createBranchOrReuse(R, branch, baseCommitSha);

  // Write files sequentially because each Contents API call advances the branch.
  // If a scaffold path already exists on the base branch, GitHub requires its
  // blob SHA to update it rather than create it.
  for (const f of scaffoldFiles) {
    const contentPath = `${R}/contents/${encodeRepoPath(f.path)}`;
    const body = {
      message: commitMessage || "azx: infra scaffold",
      content: encodeBase64Utf8(f.contents),
      branch,
    };
    try {
      await contentsPut(contentPath, body);
    } catch (err) {
      if (err.status !== 422) throw err;
      const existing = await provisioningRetry(() =>
        gh(`${contentPath}?ref=${encodeURIComponent(branch)}`),
      ).catch(() => null);
      if (!existing || !existing.sha) throw err;
      const existingContent =
        existing.encoding === "base64" ? decodeBase64Utf8(existing.content) : existing.content;
      const resolution = scaffoldConflictResolution(f.path, existingContent, f.contents, readme);
      if (resolution === "replace-seed") {
        await contentsPut(contentPath, { ...body, sha: existing.sha });
      } else if (resolution === "conflict") {
        throw new Error(
          `Repository ${owner}/${name} contains a modified scaffold file at ${f.path}; refusing to overwrite it.`,
        );
      }
    }

  }

  // 3. Open the PR into the default branch — or reuse an open one from a prior run.
  let pr;
  try {
    pr = await gh(`${R}/pulls`, {
      method: "POST",
      body: {
        title: commitMessage || "azx: infra scaffold",
        head: branch,
        base,
        body:
          "Generated by **azx**: Bicep infrastructure + an OIDC GitHub Actions deploy pipeline.\n\n" +
          "Review the files, then merge to land the infra. After merging, add the " +
          "`AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` repo variables and run " +
          "`setup-azure-oidc.sh` so the pipeline can deploy via OIDC.",
      },
    });
  } catch (err) {
    if (err.status !== 422) throw err; // 422 = a PR for this head already exists.
    const open = await gh(`${R}/pulls?head=${owner}:${branch}&base=${base}&state=open`).catch(
      () => [],
    );
    if (!open.length) throw err;
    pr = open[0];
  }

  // A completed repo must never be mistaken for an incomplete retry target.
  await gh(R, {
    method: "PATCH",
    body: { description: "Azure infrastructure generated by azx." },
  });

  return {
    htmlUrl: repo.html_url,
    prUrl: pr.html_url,
    owner,
    name,
    branch,
    base,
    login: me.login,
  };
}

export function scaffoldConflictResolution(path, existingContent, generatedContent, seedReadme) {
  if (existingContent === generatedContent) return "skip";
  if (path === "README.md" && existingContent === seedReadme) return "replace-seed";
  return "conflict";
}
