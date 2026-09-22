import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";

import { extractIntent } from "../src/extract-intent.js";
import { plan, HOSTING_POLICY } from "../src/plan.js";
import { scanFileMap } from "../src/scan-core.js";
import { generateBicep } from "../src/bicep.js";
import { buildScaffold } from "../src/scaffold.js";

const FIXED = () => new Date("2024-01-01T00:00:00.000Z");

function nextRepo(extra: Record<string, string> = {}) {
  return new Map<string, string>([
    [
      "package.json",
      JSON.stringify({
        name: "lesson-app",
        scripts: { build: "next build" },
        dependencies: { next: "16.0.0", react: "19.0.0", "react-dom": "19.0.0" },
      }),
    ],
    ["package-lock.json", "{}"],
    ["next.config.mjs", "export default {};\n"],
    ["app/page.tsx", `"use client";\nexport default function Page() { localStorage.setItem("progress", "1"); return null; }\n`],
    ...Object.entries(extra),
  ]);
}

test("client-only Next.js intent is neutral and maps to Static Web Apps", () => {
  const scan = scanFileMap("biblical-languages/app", nextRepo());
  const intent = extractIntent(scan, { now: FIXED });

  assert.deepEqual(
    intent.needs.map((need) => need.capability),
    ["static-hostable-frontend", "client-only-persistence"],
  );
  const hosting = intent.needs[0]!;
  assert.equal(hosting.basis, "inferred");
  assert.equal(hosting.options?.requiredArtifact, "static-directory");
  assert.ok(hosting.evidence.some((item) => item.includes("next")));
  assert.ok(hosting.assumptions?.some((item) => item.includes("CI build")));
  assert.equal(intent.confirmations.some((item) => item.id.startsWith("hosting:")), false);

  const resolved = plan(intent, { now: FIXED });
  assert.deepEqual(
    resolved.resources.map((resource) => resource.type),
    ["Microsoft.Web/staticSites"],
  );
  assert.equal(resolved.resources[0]?.capability, "static-hostable-frontend");
  assert.equal(resolved.resources.some((resource) => resource.type.startsWith("Microsoft.App/")), false);
});

test("Static Web Apps selects a supported allowed region or fails planning", () => {
  const intent = extractIntent(scanFileMap("owner/static-app", nextRepo()), { now: FIXED });
  const resolved = plan(intent, {
    now: FIXED,
    guardrails: { regions: ["swedencentral", "westeurope"] },
  });
  assert.equal(resolved.region, "westeurope");
  assert.equal(resolved.resources[0]?.region, "westeurope");

  assert.throws(
    () => plan(intent, { now: FIXED, guardrails: { regions: ["swedencentral"] } }),
    /Static Web Apps is unavailable/,
  );
});

test("an API route requires server compute and disqualifies static export", () => {
  const scan = scanFileMap(
    "server-app",
    nextRepo({ "app/api/status/route.ts": "export async function GET() { return Response.json({ ok: true }); }\n" }),
  );
  const intent = extractIntent(scan, { now: FIXED });

  assert.equal(intent.needs.some((need) => need.capability === "static-hostable-frontend"), false);
  const server = intent.needs.find((need) => need.capability === "http-server-runtime");
  assert.ok(server);
  assert.equal(server?.options?.requiredArtifact, "container-image");
  assert.equal(intent.confirmations.some((item) => item.capability === "http-server-runtime"), false);

  const resolved = plan(intent, { now: FIXED });
  assert.ok(resolved.resources.some((resource) => resource.type === "Microsoft.App/containerApps"));
  assert.equal(resolved.resources.some((resource) => resource.type === "Microsoft.Web/staticSites"), false);
});

test("one static-export disqualifier prevents optimistic static mapping", () => {
  const scan = scanFileMap("middleware-app", nextRepo({ "middleware.ts": "export function middleware() {}\n" }));
  const intent = extractIntent(scan, { now: FIXED });
  const resolved = plan(intent, { now: FIXED });

  assert.equal(intent.needs.some((need) => need.capability === "http-server-runtime"), true);
  assert.equal(resolved.resources.some((resource) => resource.type === "Microsoft.Web/staticSites"), false);
});

test("configless src/app API routes still require server compute", () => {
  const files = nextRepo({ "src/app/api/status/route.ts": "export function GET() { return Response.json({}); }\n" });
  files.delete("next.config.mjs");
  const intent = extractIntent(scanFileMap("configless-app", files), { now: FIXED });

  assert.equal(intent.needs.some((need) => need.capability === "http-server-runtime"), true);
  assert.equal(intent.needs.some((need) => need.capability === "static-hostable-frontend"), false);
});

test("root app/api/route handlers require server compute", () => {
  const intent = extractIntent(
    scanFileMap("root-api-app", nextRepo({ "app/api/route.ts": "export function POST() { return new Response(); }\n" })),
    { now: FIXED },
  );
  assert.equal(intent.needs.some((need) => need.capability === "http-server-runtime"), true);
});

test("a Node lockfile does not turn an Express server into a static frontend", () => {
  const files = new Map<string, string>([
    ["package.json", JSON.stringify({ dependencies: { express: "5.0.0" } })],
    ["package-lock.json", "{}"],
    ["server.js", "import express from 'express'; express().listen(3000);\n"],
  ]);
  const intent = extractIntent(scanFileMap("express-app", files), { now: FIXED });
  const resolved = plan(intent, { now: FIXED });

  assert.equal(intent.needs.some((need) => need.capability === "static-hostable-frontend"), false);
  assert.equal(resolved.resources.some((resource) => resource.type === "Microsoft.Web/staticSites"), false);
  assert.equal(resolved.resources.some((resource) => resource.type === "Microsoft.App/containerApps"), true);
});

test("Next.js with an explicit server dependency or standalone output stays on server compute", () => {
  const mixed = nextRepo();
  const pkg = JSON.parse(mixed.get("package.json")!);
  pkg.dependencies.express = "5.0.0";
  mixed.set("package.json", JSON.stringify(pkg));
  const mixedIntent = extractIntent(scanFileMap("mixed-app", mixed), { now: FIXED });
  assert.equal(mixedIntent.needs.some((need) => need.capability === "http-server-runtime"), true);

  const standalone = nextRepo();
  standalone.set("next.config.mjs", `export default { output: "standalone" };\n`);
  const standaloneIntent = extractIntent(scanFileMap("standalone-app", standalone), { now: FIXED });
  assert.equal(standaloneIntent.needs.some((need) => need.capability === "http-server-runtime"), true);
});

test("only class-changing routing ambiguity creates a hosting question", () => {
  const files = nextRepo();
  files.set("next.config.mjs", "export default { async rewrites() { return []; } };\n");
  const intent = extractIntent(scanFileMap("ambiguous-app", files), { now: FIXED });

  assert.deepEqual(
    intent.confirmations.filter((item) => item.id.startsWith("hosting:")).map((item) => item.id),
    ["hosting:static-export"],
  );
});

test("explicit hosting override is preserved as user-confirmed evidence", () => {
  const scan = scanFileMap("override-app", nextRepo({ "middleware.ts": "export function middleware() {}\n" }));
  const intent = extractIntent(scan, { now: FIXED, hostingOverride: "static" });
  const hosting = intent.needs.find((need) => need.capability === "static-hostable-frontend");

  assert.equal(hosting?.basis, "user-confirmed");
  assert.deepEqual(hosting?.evidence, ["Explicit hosting override: static"]);
  assert.equal(intent.needs.some((need) => need.capability === "http-server-runtime"), false);
});

test("static scaffold builds and publishes the real out directory", () => {
  const intent = extractIntent(scanFileMap("biblical-languages/app", nextRepo()), { now: FIXED });
  const resolved = plan(intent, { now: FIXED });
  const sourceRef = "0123456789abcdef0123456789abcdef01234567";
  const files = buildScaffold(intent, resolved, generateBicep(resolved), {
    sourceRef,
    sourcePath: "apps/lesson",
  });
  const workflow = files.find((file) => file.path === ".github/workflows/deploy.yml")!.content;
  const doc = parseYaml(workflow) as any;

  assert.deepEqual(HOSTING_POLICY.map((entry) => entry.capability), [
    "static-hostable-frontend",
    "http-server-runtime",
    "web-compute",
  ]);
  assert.ok(doc.jobs["publish-static-app"]);
  assert.match(workflow, /repository: biblical-languages\/app/);
  assert.match(workflow, new RegExp(`ref: ${sourceRef}`));
  assert.match(workflow, /npm ci[\s\S]*npm run build[\s\S]*\[ -d out \]/);
  assert.match(workflow, /cache-dependency-path: application\/apps\/lesson\/package-lock\.json/);
  assert.match(workflow, /working-directory: application\/apps\/lesson/);
  assert.match(workflow, /app_location: application\/apps\/lesson\/out/);
  assert.match(workflow, /skip_app_build: true/);
  assert.doesNotMatch(workflow, /mcr\.microsoft\.com\/k8se\/quickstart/);
});

test("static scaffold uses the detected package manager and requires a lockfile", () => {
  const files = nextRepo();
  files.delete("package-lock.json");
  files.set("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const intent = extractIntent(scanFileMap("owner/pnpm-app", files), { now: FIXED });
  const resolved = plan(intent, { now: FIXED });
  const workflow = buildScaffold(intent, resolved, generateBicep(resolved)).find(
    (file) => file.path === ".github/workflows/deploy.yml",
  )!.content;

  assert.match(workflow, /corepack enable/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm run build/);
  assert.doesNotMatch(workflow, /cache: pnpm/);

  const unlocked = nextRepo();
  unlocked.delete("package-lock.json");
  const unlockedIntent = extractIntent(scanFileMap("owner/unlocked-app", unlocked), { now: FIXED });
  const unlockedPlan = plan(unlockedIntent, { now: FIXED });
  assert.throws(
    () => buildScaffold(unlockedIntent, unlockedPlan, generateBicep(unlockedPlan)),
    /requires a supported lockfile/,
  );
});
