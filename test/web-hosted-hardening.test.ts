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
  };
  const result = await worker.fetch(new Request("https://worker.example/health"), secrets);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), { status: "ok" });
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

test("Pages documentation does not claim meta CSP prevents framing", () => {
  const readme = source("web/README.md");
  assert.match(readme, /cannot enforce `frame-ancestors`/);
  assert.match(readme, /must be real HTTP\s+headers/);
});
