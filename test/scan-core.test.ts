import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readRepo } from "../src/read-repo.js";
import { scanFileMap } from "../src/scan-core.js";

/**
 * The browser SPA and the Node CLI must run the SAME detection. `readRepo` walks
 * the disk; `scanFileMap` runs over an in-memory file map (what the browser builds
 * from the GitHub API). This test builds the map the CLI would produce and asserts
 * the two paths yield byte-identical signals — locking in the single source of truth.
 */

const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".turbo", ".venv", "venv",
  "env", "__pycache__", ".mypy_cache", ".pytest_cache", "coverage", ".azx",
]);
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sql", ".yml", ".yaml",
  ".toml", ".json", ".cfg", ".ini", ".txt", ".md",
]);

function buildMap(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (!IGNORE.has(name)) walk(abs);
      } else if (st.isFile()) {
        const dot = name.lastIndexOf(".");
        const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
        const ok =
          TEXT_EXT.has(ext) ||
          name === ".env" ||
          name.startsWith(".env") ||
          name === "Dockerfile" ||
          name.startsWith("Dockerfile") ||
          name === "Pipfile";
        if (ok && st.size <= 256 * 1024) {
          files.set(relative(root, abs).split(sep).join("/"), readFileSync(abs, "utf8"));
        }
      }
    }
  };
  walk(root);
  return files;
}

const APPS_DIR = fileURLToPath(new URL("../../test/e2e/apps", import.meta.url));

for (const app of readdirSync(APPS_DIR)) {
  test(`scanFileMap matches readRepo on e2e/apps/${app}`, () => {
    const root = join(APPS_DIR, app);
    const viaDisk = readRepo(root);
    const viaMap = scanFileMap(app, buildMap(root));
    assert.deepEqual(
      viaMap.signals,
      viaDisk.signals,
      `browser-path signals diverged from CLI-path signals for ${app}`,
    );
    // app.name may be refined from package.json in both paths identically.
    assert.equal(viaMap.app.name, viaDisk.app.name);
  });
}
