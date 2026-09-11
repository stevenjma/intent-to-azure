import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fromDist = /[\\/]dist[\\/]test[\\/]/.test(fileURLToPath(import.meta.url));
const root = new URL(fromDist ? "../../" : "../", import.meta.url);

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, root)), "utf8");
}

async function importSource(rel: string): Promise<any> {
  const encoded = Buffer.from(source(rel)).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("OAuth redirect allowlist uses exact parsed origin and app path", async () => {
  const { isAllowedReturnUrl } = await importSource("web/worker/github-oauth-worker.js");
  const app = new URL("https://example.github.io/azx/");
  assert.equal(isAllowedReturnUrl("https://example.github.io/azx/", app), true);
  assert.equal(isAllowedReturnUrl("https://example.github.io/azx/?return=1", app), true);
  assert.equal(isAllowedReturnUrl("https://example.github.io.evil.test/azx/", app), false);
  assert.equal(isAllowedReturnUrl("https://example.github.io/azx-evil/", app), false);
  assert.equal(isAllowedReturnUrl("https://example.github.io/", app), false);
});

test("OAuth Worker rejects popup and wrong-path state before token exchange", async () => {
  const worker = (await importSource("web/worker/github-oauth-worker.js")).default;
  const env = {
    GITHUB_CLIENT_ID: "client",
    GITHUB_CLIENT_SECRET: "secret",
    ALLOWED_ORIGIN: "https://example.github.io",
    APP_URL: "https://example.github.io/azx/",
  };
  const popup = await worker.fetch(
    new Request("https://worker.example/login?state=00000000-0000-4000-8000-000000000000.p"),
    env,
  );
  assert.equal(popup.status, 400);
  const wrongReturn = Buffer.from("https://example.github.io/other/").toString("base64url");
  const wrongPath = await worker.fetch(
    new Request(`https://worker.example/login?state=00000000-0000-4000-8000-000000000000.r.${wrongReturn}`),
    env,
  );
  assert.equal(wrongPath.status, 400);
});

test("OAuth Worker health endpoint is unauthenticated and discloses no configuration", async () => {
  const worker = (await importSource("web/worker/github-oauth-worker.js")).default;
  const secrets = {
    GITHUB_CLIENT_ID: "sensitive-client",
    GITHUB_CLIENT_SECRET: "sensitive-secret",
    ALLOWED_ORIGIN: "https://example.github.io",
    APP_URL: "https://example.github.io/azx/",
  };
  const result = await worker.fetch(new Request("https://worker.example/health"), secrets);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { status: "ok", deployment: "unknown" });
  const serialized = await (await worker.fetch(
    new Request("https://worker.example/health"),
    secrets,
  )).text();
  for (const value of Object.values(secrets)) assert.equal(serialized.includes(value), false);

  const post = await worker.fetch(
    new Request("https://worker.example/health", { method: "POST" }),
    secrets,
  );
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");

  const unhealthy = await worker.fetch(
    new Request("https://worker.example/health"),
    { ...secrets, GITHUB_CLIENT_SECRET: "" },
  );
  assert.equal(unhealthy.status, 503);
  assert.deepEqual(await unhealthy.json(), { status: "error", deployment: "unknown" });
});

test("ARM polling continues through HTTP 200 Running until explicit success", async () => {
  const { pollArmOperation } = await importSource("web/arm-poll.js");
  const queue = [
    response(200, { status: "InProgress" }),
    response(200, { status: "Running" }),
    response(200, { status: "Succeeded", properties: { changes: [] } }),
  ];
  let clock = 0;
  const result = await pollArmOperation(
    response(200, { status: "InProgress" }),
    async () => queue.shift(),
    {
      pollUrl: "https://arm.test/op",
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
    },
  );
  assert.equal(result.status, "Succeeded");
  assert.equal(queue.length, 0);
});

test("ARM polling surfaces terminal failure and rejects ambiguous HTTP 200", async () => {
  const { pollArmOperation } = await importSource("web/arm-poll.js");
  const opts = { now: () => 0, sleep: async () => {} };
  await assert.rejects(
    pollArmOperation(response(200, { status: "Failed", error: { message: "quota" } }), async () => null, opts),
    /failed: quota/i,
  );
  await assert.rejects(
    pollArmOperation(response(200, { properties: {} }), async () => null, opts),
    /without a terminal success state/i,
  );
});

test("ARM polling defaults to five seconds when Retry-After is absent", async () => {
  const { pollArmOperation } = await importSource("web/arm-poll.js");
  let clock = 0;
  const waits: number[] = [];
  await pollArmOperation(
    response(202, { status: "Running" }, { location: "https://arm.test/op" }),
    async () => response(200, { status: "Succeeded" }),
    {
      now: () => clock,
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
    },
  );
  assert.deepEqual(waits, [5_000]);
});

test("hosted scan excludes real dotenv files but retains .env.example", () => {
  const github = source("web/github.js");
  assert.match(github, /Never download live dotenv files/);
  assert.doesNotMatch(github, /"docker-compose\.yaml", "\.env",/);
  assert.match(github, /\^\\\.env\\\.\example\$/i);
});

test("incomplete scans and stale analyses fail closed", () => {
  const app = source("web/app.js");
  assert.match(app, /if \(truncated\) \{\s*throw new Error/);
  assert.match(app, /analysisController\?\.abort\(\)/);
  assert.match(app, /sequence !== analysisSequence/);
  assert.match(app, /"pg-password"/);
  assert.match(app, /requireResolvedConfirmations\(\)/);
  assert.match(app, /!confirmation\.assumption \|\| confirmationApprovalSequence !== analysisSequence/);
  assert.match(app, /checkbox\.disabled = requiredDecisions\.length > 0/);
});

test("repo retry provenance is marked and feature refs are never force-reset", () => {
  const github = source("web/github.js");
  assert.match(github, /azx-incomplete-repository-v1/);
  assert.match(github, /was not created by an incomplete azx run/);
  assert.doesNotMatch(github, /force:\s*true/);
  assert.match(github, /modified scaffold file/);
});

test("hosted ship replaces only its inherited seed README", async () => {
  const { scaffoldConflictResolution } = await importSource("web/github.js");
  const seed = "# app\n\nAzure infrastructure generated by azx.\n";
  const generated = "# app\n\nFull generated deployment guide.\n";
  assert.equal(scaffoldConflictResolution("README.md", seed, generated, seed), "replace-seed");
  assert.equal(scaffoldConflictResolution("README.md", generated, generated, seed), "skip");
  assert.equal(scaffoldConflictResolution("README.md", "# user edit\n", generated, seed), "conflict");
  assert.equal(scaffoldConflictResolution("infra/main.bicep", "user edit", "generated", seed), "conflict");
});

test("OAuth fragment is validated and removed before third-party modules load", () => {
  const html = source("web/index.html");
  const bootstrap = source("web/bootstrap.js");
  assert.match(html, /src="\.\/bootstrap\.js/);
  assert.doesNotMatch(html, /src="\.\/app\.js/);
  assert.match(bootstrap, /state !== expected/);
  assert.match(bootstrap, /history\.replaceState/);
  assert.doesNotMatch(bootstrap, /setItem\([^)]*(token|oauth_result)/i);
  assert.match(bootstrap, /await import\("\.\/app\.js/);
});

test("OAuth providers canonicalize index.html to the application directory", () => {
  const github = source("web/github.js");
  const azure = source("web/azure.js");
  assert.match(github, /new URL\("\.", window\.location\.href\)\.href/);
  assert.match(azure, /function appRedirectUri\(\)/);
  assert.equal((azure.match(/appRedirectUri\(\)/g) || []).length, 4);
});

test("hosted module cache keys move together for release changes", () => {
  const html = source("web/index.html");
  const bootstrap = source("web/bootstrap.js");
  const app = source("web/app.js");
  const version = html.match(/bootstrap\.js\?v=([^"]+)/)?.[1];
  assert.ok(version);
  assert.ok(bootstrap.includes(`app.js?v=${version}`));
  for (const module of ["engine/web-engine", "github", "azure"]) {
    assert.ok(app.includes(`${module}.js?v=${version}`));
  }
});

test("Pages documentation does not claim meta CSP prevents framing", () => {
  const readme = source("web/README.md");
  assert.match(readme, /cannot enforce `frame-ancestors`/);
  assert.match(readme, /must be real HTTP\s+headers/);
});

test("hosted preview states that it provisions infrastructure, not application code", () => {
  const html = source("web/index.html");
  assert.match(html, /Public preview/);
  assert.match(html, /does not build or deploy your application code/);
  assert.match(html, /Microsoft placeholder images/);
  assert.match(html, /GitHub Issues/);
});

test("production probes require an explicit Worker deployment identity", () => {
  for (const workflow of [
    source(".github/workflows/health.yml"),
    source(".github/workflows/deploy-worker.yml"),
  ]) {
    assert.match(workflow, /jq -e '\.status == "ok"'/);
    assert.match(workflow, /\.deployment \| type == "string" and length > 0 and \. != "unknown"/);
    assert.doesNotMatch(workflow, /! grep -q '"deployment":"unknown"'/);
  }
});

test("Pages uploads the artifact filename required by deploy-pages", () => {
  const workflow = source(".github/workflows/pages.yml");
  assert.match(workflow, /\$RUNNER_TEMP\/artifact\.tar/);
  assert.match(workflow, /\$\{\{ runner\.temp \}\}\/artifact\.tar/);
  assert.doesNotMatch(workflow, /github-pages\.tar/);
});

test("E2E OIDC setup fails closed when reusing or granting access", () => {
  const bash = source("scripts/setup-azure-oidc.sh");
  const powershell = source("scripts/setup-azure-oidc.ps1");

  assert.match(bash, /--app-id <existingAppId>/);
  assert.match(bash, /refusing implicit reuse/);
  assert.match(bash, /actions\/oidc\/customization\/sub/);
  assert.match(bash, /SUB_CLAIM_PREFIX/);
  assert.match(bash, /credential_issuer.*ISSUER/);
  assert.match(bash, /credential_audience.*AUD/);
  assert.match(bash, /failed to grant Contributor/);

  assert.match(powershell, /-AppId <existingAppId>/);
  assert.match(powershell, /refusing implicit reuse/);
  assert.match(powershell, /actions\/oidc\/customization\/sub/);
  assert.match(powershell, /\$subClaimPrefix/);
  assert.match(powershell, /\$credential\.issuer -ne \$issuer/);
  assert.match(powershell, /\$audiences\.Count -ne 1/);
  assert.match(powershell, /failed to grant Contributor/);
});
