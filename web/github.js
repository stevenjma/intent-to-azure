/**
 * github.js — GitHub connect + repo I/O for the SPA, over plain fetch (no SDK).
 *
 * OAuth: a static page can't do the code→token exchange (needs the client secret +
 * the token endpoint is CORS-blocked), so we bounce through a tiny token-exchange
 * Worker (see web/worker/). The Worker holds the secret, does the exchange, and
 * posts the user token back to this window. We keep the token in memory only.
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
  ".rs", ".java", ".cs", ".php", ".yaml", ".yml", ".toml", ".env", ".txt",
  ".md", ".lock", ".sh", ".dockerfile", ".prisma", ".sql", ".html", ".css",
]);
const INTERESTING = new Set([
  "package.json", "package-lock.json", "requirements.txt", "pyproject.toml",
  "Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".env", ".env.example",
  "next.config.js", "next.config.mjs", "go.mod", "Gemfile", "pom.xml",
]);
const MAX_FILE_BYTES = 1_500_000;
const MAX_BLOB_FETCHES = 400;

/** In-memory token + user, never persisted. */
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

function ext(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.toLowerCase() === "dockerfile") return ".dockerfile";
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i).toLowerCase();
}

function wantFile(path, size) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (size > MAX_FILE_BYTES) return false;
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

async function gh(path, { method = "GET", body, raw = false } = {}) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
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
 * Kick off GitHub OAuth via a popup to the Worker's /login, which redirects to
 * GitHub, exchanges the code, and postMessages `{ type: "azx-github-token", token }`
 * back here. Resolves once the token arrives (and we've fetched the user).
 */
export function githubSignIn(config) {
  return new Promise((resolve, reject) => {
    if (!config.githubWorkerUrl || !config.githubClientId) {
      reject(new Error("GitHub not configured (githubClientId / githubWorkerUrl)."));
      return;
    }
    const state = crypto.randomUUID();
    const loginUrl =
      `${config.githubWorkerUrl.replace(/\/$/, "")}/login` +
      `?state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent(config.githubScopes || "repo read:user")}`;

    const popup = window.open(loginUrl, "azx-github-oauth", "width=560,height=720");
    if (!popup) {
      reject(new Error("Popup blocked — allow popups for this site and retry."));
      return;
    }

    const workerOrigin = new URL(config.githubWorkerUrl).origin;
    const onMessage = async (ev) => {
      if (ev.origin !== workerOrigin) return;
      const data = ev.data || {};
      if (data.type !== "azx-github-token") return;
      window.removeEventListener("message", onMessage);
      try {
        popup.close();
      } catch {
        /* ignore */
      }
      if (data.error) {
        reject(new Error(`GitHub sign-in failed: ${data.error}`));
        return;
      }
      if (data.state !== state) {
        reject(new Error("GitHub OAuth state mismatch — aborting."));
        return;
      }
      token = data.token;
      try {
        user = await gh("/user");
        resolve(user);
      } catch (err) {
        reject(err);
      }
    };
    window.addEventListener("message", onMessage);
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
export async function fetchRepoFiles(ownerRepo, ref) {
  const [owner, repo] = ownerRepo.split("/").map((s) => s.trim());
  if (!owner || !repo) throw new Error('Enter a repo as "owner/repo".');

  const meta = await gh(`/repos/${owner}/${repo}`);
  const branch = ref && ref.trim() ? ref.trim() : meta.default_branch;
  const branchInfo = await gh(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  const treeSha = branchInfo.commit.commit.tree.sha;

  const tree = await gh(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
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
    const blob = await gh(`/repos/${owner}/${repo}/git/blobs/${node.sha}`);
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

async function createOrResetBranch(repoPath, branch, sha) {
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
          await gh(`${repoPath}/git/ref/heads/${branch}`);
          await gitWrite(
            `${repoPath}/git/refs/heads/${branch}`,
            { sha, force: true },
            "PATCH",
          );
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
 * repository after the seed commit succeeds. Git-data is used only to create or
 * reset the feature branch ref, with exponential retry while it becomes visible.
 *
 * The whole flow is idempotent: a prior failed run can leave behind an empty
 * repo the SPA can't delete (no `delete_repo` scope), so on a name-conflict 422
 * we reuse the existing repo, seed the base branch only if it's empty,
 * create-or-fast-forward the `azx-infra` branch, and create-or-reuse the PR.
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
  let repo;
  try {
    repo = await gh(createPath, {
      method: "POST",
      body: { name: rawName, private: Boolean(isPrivate), auto_init: false },
    });
  } catch (err) {
    if (err.status !== 422) throw err;
    const existing = await gh(`/repos/${ownerPath}/${rawName}`).catch(() => null);
    if (!existing) throw err; // 422 for some other reason (name policy, perms, quota).
    repo = existing;
  }
  // Always follow up against the repo's REAL owner/name, never the raw input.
  const owner = repo.owner.login;
  const name = repo.name;
  const base = repo.default_branch || "main";
  const R = `/repos/${owner}/${name}`;

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
  if (!baseCommitSha) {
    const readme = `# ${name}\n\nAzure infrastructure generated by azx.\n`;
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

  // 2. Feature branch: create it from the base commit, or reset an existing
  //    branch so a retried Codify run produces exactly the requested scaffold.
  const branch = "azx-infra";
  await createOrResetBranch(R, branch, baseCommitSha);

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
      await contentsPut(contentPath, { ...body, sha: existing.sha });
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
