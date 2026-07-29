/**
 * Vercel-migration awareness: azx reads a Vercel project as a *migration source*.
 * A committed `vercel.json` (or the linked-project `.vercel/project.json` marker)
 * must surface a web-compute deploy-convention signal tagged `deploy: "vercel"`
 * and `migration: true`, so flipping a Vercel app to Azure Container Apps is
 * first-class in the signals table and evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRepo } from "../src/index.js";
import type { Signal } from "../src/types.js";

function vercelSignal(signals: Signal[]): Signal | undefined {
  return signals.find((s) => (s.detail as Record<string, unknown> | undefined)?.deploy === "vercel");
}

test("vercel.json marks a Next.js app as a Vercel → Azure migration source", () => {
  const root = mkdtempSync(join(tmpdir(), "azx-vercel-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "vercel-fixture", dependencies: { next: "16.0.0", react: "19.0.0" } }),
      "utf8",
    );
    writeFileSync(join(root, "next.config.mjs"), "export default {}\n", "utf8");
    writeFileSync(join(root, "vercel.json"), JSON.stringify({ buildCommand: "next build" }), "utf8");

    const { signals } = readRepo(root);
    const sig = vercelSignal(signals);
    assert.ok(sig, "expected a Vercel deploy-convention signal");
    assert.equal(sig?.kind, "config");
    assert.equal(sig?.capability, "web-compute");
    assert.equal((sig?.detail as Record<string, unknown>)?.migration, true);
    assert.match(sig?.signal ?? "", /vercel\.json/);
    assert.match(sig?.conclusion ?? "", /Vercel/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(".vercel/project.json is the linked-project fallback when vercel.json is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "azx-vercel-linked-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "linked-fixture", dependencies: { next: "16.0.0" } }),
      "utf8",
    );
    mkdirSync(join(root, ".vercel"));
    writeFileSync(
      join(root, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_x", orgId: "team_y" }),
      "utf8",
    );

    const { signals } = readRepo(root);
    const sig = vercelSignal(signals);
    assert.ok(sig, "expected a Vercel signal from .vercel/project.json");
    assert.match(sig?.signal ?? "", /\.vercel\/project\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apps with no Vercel markers produce no Vercel signal", () => {
  const root = mkdtempSync(join(tmpdir(), "azx-novercel-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "plain-fixture", dependencies: { next: "16.0.0" } }),
      "utf8",
    );
    const { signals } = readRepo(root);
    assert.equal(vercelSignal(signals), undefined, "must not fabricate a Vercel signal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
