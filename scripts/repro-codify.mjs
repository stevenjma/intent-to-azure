import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { __setAuth, createRepoAndPush } from "../web/github.js";

// Live-only acceptance harness. Set CODIFY_REPRO_RUNS, CODIFY_REPRO_OWNER,
// CODIFY_REPRO_PREFIX, or CODIFY_REPRO_REPO to adjust a run.
const API = "https://api.github.com";
const OWNER = process.env.CODIFY_REPRO_OWNER || "stevenjma";
const RUNS = Number.parseInt(process.env.CODIFY_REPRO_RUNS || "20", 10);
const REPO_PREFIX = process.env.CODIFY_REPRO_PREFIX || "azx-repro";
const FIXED_REPO = process.env.CODIFY_REPRO_REPO || "";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_DIR = path.join(ROOT, "scripts", ".repro-codify-results");
const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const originalFetch = globalThis.fetch;

if (!token) throw new Error("gh auth token returned an empty token.");
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error("CODIFY_REPRO_RUNS must be a positive integer.");

const requestEvents = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = init.method || (typeof input === "string" ? "GET" : input.method) || "GET";
  const startedAt = performance.now();
  try {
    const response = await originalFetch(input, init);
    if (url.origin === API) {
      requestEvents.push({
        method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    }
    return response;
  } catch (error) {
    if (url.origin === API) {
      requestEvents.push({
        method,
        path: `${url.pathname}${url.search}`,
        status: "network-error",
        elapsedMs: Math.round(performance.now() - startedAt),
        error: error.message,
      });
    }
    throw error;
  }
};

const scaffoldFiles = [
  {
    path: "infra/main.bicep",
    contents: "param location string = resourceGroup().location\noutput repro string = 'codify-live-repro'\n",
  },
  {
    path: ".github/workflows/deploy-infra.yml",
    contents:
      "name: Deploy infrastructure\non:\n  workflow_dispatch:\njobs:\n  repro:\n    runs-on: ubuntu-latest\n" +
      "    steps:\n      - run: echo codify-live-repro\n",
  },
  {
    path: "app-intent.yaml",
    contents: "name: codify-live-repro\nruntime:\n  kind: static\n",
  },
  {
    path: "README.md",
    contents: "# Codify live repro\n\nThis file replaces the seeded README on `azx-infra`.\n",
  },
];

async function api(pathname) {
  const response = await originalFetch(`${API}${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Verification GET ${pathname} -> ${response.status}: ${detail}`);
  }
  return response.json();
}

const authUser = await api("/user");
__setAuth(token, authUser);

async function verify(result) {
  const repoPath = `/repos/${result.owner}/${result.name}`;
  const baseRef = await api(`${repoPath}/git/ref/heads/${encodeURIComponent(result.base)}`);
  const branchRef = await api(`${repoPath}/git/ref/heads/${encodeURIComponent(result.branch)}`);
  const compare = await api(
    `${repoPath}/compare/${encodeURIComponent(baseRef.object.sha)}...` +
      `${encodeURIComponent(branchRef.object.sha)}`,
  );
  const expectedPaths = new Set(scaffoldFiles.map((file) => file.path));
  const changedPaths = new Set((compare.files || []).map((file) => file.filename));
  const missing = [...expectedPaths].filter((filePath) => !changedPaths.has(filePath));
  const unexpected = [...changedPaths].filter((filePath) => !expectedPaths.has(filePath));
  const pulls = await api(
    `${repoPath}/pulls?head=${encodeURIComponent(`${result.owner}:${result.branch}`)}` +
      `&base=${encodeURIComponent(result.base)}&state=open`,
  );
  if (!baseRef.object?.sha) throw new Error("Base branch has no commit.");
  if (!branchRef.object?.sha) throw new Error("azx-infra branch has no commit.");
  if (missing.length) throw new Error(`azx-infra diff is missing files: ${missing.join(", ")}`);
  if (unexpected.length) throw new Error(`azx-infra diff has stale files: ${unexpected.join(", ")}`);
  if (!pulls.length) throw new Error("No open scaffold PR exists.");
  for (const file of scaffoldFiles) {
    const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
    const content = await api(
      `${repoPath}/contents/${encodedPath}?ref=${encodeURIComponent(result.branch)}`,
    );
    const actual = Buffer.from(content.content.replace(/\n/g, ""), "base64").toString("utf8");
    if (actual !== file.contents) throw new Error(`${file.path} content does not match the scaffold.`);
  }
  return {
    baseSha: baseRef.object.sha,
    branchSha: branchRef.object.sha,
    prUrl: pulls[0].html_url,
    scaffoldPaths: scaffoldFiles.map((file) => file.path),
  };
}

function summarizeRetries(events) {
  const retries = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.status !== 404 && event.status !== 409) continue;
    let failures = 1;
    let cursor = index + 1;
    while (
      cursor < events.length &&
      events[cursor].method === event.method &&
      events[cursor].path === event.path &&
      (events[cursor].status === 404 || events[cursor].status === 409)
    ) {
      failures++;
      cursor++;
    }
    if (
      cursor < events.length &&
      events[cursor].method === event.method &&
      events[cursor].path === event.path &&
      events[cursor].status >= 200 &&
      events[cursor].status < 300
    ) {
      retries.push({
        method: event.method,
        path: event.path,
        failures,
        attempts: failures + 1,
        statuses: events.slice(index, cursor + 1).map((item) => item.status),
      });
      index = cursor;
    }
  }
  return retries;
}

await mkdir(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const report = {
  startedAt: new Date().toISOString(),
  owner: OWNER,
  requestedRuns: RUNS,
  runs: [],
};

for (let index = 1; index <= RUNS; index++) {
  const repoName = FIXED_REPO || `${REPO_PREFIX}-${stamp}-${String(index).padStart(2, "0")}`;
  requestEvents.length = 0;
  const startedAt = performance.now();
  const row = { index, repoName };
  try {
    const result = await createRepoAndPush(
      `${OWNER}/${repoName}`,
      true,
      scaffoldFiles,
      "azx: live Codify repro scaffold",
    );
    row.verification = await verify(result);
    row.success = true;
    row.prUrl = result.prUrl;
  } catch (error) {
    row.success = false;
    row.error = error.stack || error.message;
  }
  row.elapsedMs = Math.round(performance.now() - startedAt);
  row.raceResponses = requestEvents.filter((event) => event.status === 404 || event.status === 409);
  row.retries = summarizeRetries(requestEvents);
  row.requests = [...requestEvents];
  report.runs.push(row);
  const retryText = row.retries.length
    ? `; retries: ${row.retries.map((item) => `${item.method} ${item.path} ${item.attempts} attempts`).join(", ")}`
    : "";
  console.log(
    `[${index}/${RUNS}] ${row.success ? "PASS" : "FAIL"} ${repoName} ${row.elapsedMs}ms${retryText}`,
  );
  if (!row.success) console.error(row.error);
}

report.finishedAt = new Date().toISOString();
report.passed = report.runs.filter((run) => run.success).length;
report.failed = report.runs.length - report.passed;
const reportPath = path.join(RESULTS_DIR, `${stamp}.json`);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`\nResult: ${report.passed}/${report.runs.length} passed; report: ${reportPath}`);
const listCommand =
  `gh repo list ${OWNER} --limit 1000 --json name --jq ` +
  `'.[] | select(.name | startswith("${REPO_PREFIX}-")) | .name'`;
console.log(`Cleanup list: ${listCommand}`);
console.log(
  `Cleanup (PowerShell): ${listCommand} | ForEach-Object { gh repo delete "${OWNER}/$_" --yes }`,
);

process.exitCode = report.failed ? 1 : 0;
