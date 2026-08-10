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
 * Repo write (ship): create a repo, then the git-data dance (blobs → tree → commit →
 * ref) to push the generated scaffold in one commit. No local git.
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
    throw new Error(`GitHub ${method} ${path} → ${res.status} ${detail}`.trim());
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

/**
 * Create a new repo under the signed-in user and push `scaffoldFiles`
 * ([{ path, contents }]) as a single initial commit via the git-data API.
 * Returns the new repo's html_url.
 */
export async function createRepoAndPush(name, isPrivate, scaffoldFiles, commitMessage) {
  if (!token) throw new Error("Sign in with GitHub first.");
  const me = user || (await gh("/user"));

  const repo = await gh("/user/repos", {
    method: "POST",
    body: { name, private: Boolean(isPrivate), auto_init: false },
  });
  const owner = repo.owner.login;

  // 1. Blobs for every file.
  const treeItems = [];
  for (const f of scaffoldFiles) {
    const blob = await gh(`/repos/${owner}/${name}/git/blobs`, {
      method: "POST",
      body: { content: f.contents, encoding: "utf-8" },
    });
    treeItems.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // 2. Tree → 3. commit (no parent = initial) → 4. create default branch ref.
  const tree = await gh(`/repos/${owner}/${name}/git/trees`, {
    method: "POST",
    body: { tree: treeItems },
  });
  const commit = await gh(`/repos/${owner}/${name}/git/commits`, {
    method: "POST",
    body: { message: commitMessage || "azx: initial infra scaffold", tree: tree.sha, parents: [] },
  });
  const branch = repo.default_branch || "main";
  await gh(`/repos/${owner}/${name}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });

  return { htmlUrl: repo.html_url, owner, name, branch, login: me.login };
}
