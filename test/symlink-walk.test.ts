/**
 * Safety guard (FIX 3): the repo walker must not follow symlinks, so a symlink
 * pointing outside the scan root can never pull external files into the scan.
 *
 * Creating a real symlink needs privilege on Windows (Developer Mode / admin);
 * if the OS refuses, we skip so CI stays green rather than failing spuriously.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRepo } from "../src/index.js";

test("walk() skips symlinks and never scans outside the root", (t) => {
  const base = mkdtempSync(join(tmpdir(), "azx-symlink-"));
  const root = join(base, "repo");
  const outside = join(base, "outside");
  try {
    mkdirSync(root);
    mkdirSync(outside);
    // An outside .env that WOULD produce a signal if the walker followed it.
    writeFileSync(join(outside, ".env"), "OPENAI_API_KEY=sk-should-not-be-scanned\n", "utf8");
    // A legitimate in-repo file so the scan isn't empty.
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "symlink-fixture" }), "utf8");

    try {
      // Directory symlink from inside the repo to the outside dir.
      symlinkSync(outside, join(root, "escape"), "dir");
    } catch (err) {
      t.skip(`symlink creation not permitted on this OS: ${(err as Error).message}`);
      return;
    }

    const scan = readRepo(root);
    const serialized = JSON.stringify(scan);

    // No signal should originate from anything under the symlinked "escape" dir.
    assert.ok(
      scan.signals.every((s) => !String(s.from ?? "").startsWith("escape")),
      "walker must not follow the symlink into the outside directory",
    );
    assert.ok(
      !serialized.includes("sk-should-not-be-scanned"),
      "content behind the symlink must never be scanned",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readRepo includes Yarn and Bun lockfiles used by static delivery", () => {
  for (const lockfile of ["yarn.lock", "bun.lock", "bun.lockb"]) {
    const root = mkdtempSync(join(tmpdir(), "azx-lockfile-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "lockfile-fixture", dependencies: { next: "15.0.0" } }),
        "utf8",
      );
      writeFileSync(join(root, lockfile), "", "utf8");
      const scan = readRepo(root);
      assert.equal(scan.app.lockfile, lockfile);
      assert.equal(scan.app.packageManager, lockfile === "yarn.lock" ? "yarn" : "bun");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("readRepo preserves lockfile presence above the text scan size limit", () => {
  const root = mkdtempSync(join(tmpdir(), "azx-large-lockfile-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "large-lockfile-fixture", dependencies: { next: "15.0.0" } }),
      "utf8",
    );
    const lockfile = join(root, "yarn.lock");
    writeFileSync(lockfile, "", "utf8");
    truncateSync(lockfile, 300 * 1024);
    const scan = readRepo(root);
    assert.equal(scan.app.lockfile, "yarn.lock");
    assert.equal(scan.app.packageManager, "yarn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
