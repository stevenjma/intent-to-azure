/**
 * Stage [0] read-repo — Node adapter that walks the real filesystem and delegates
 * capability detection to the browser-safe `scan-core` module (the single source
 * of truth for detection). We skim the repo the way a senior engineer would —
 * manifests, lockfiles, migrations, env files, source imports, Dockerfiles and CI
 * workflows — build an in-memory map of text files, and hand it to `scanFileMap`.
 *
 * Pure and offline: this only reads the local filesystem. No network.
 */

import { readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { scanFileMap, type RepoScan } from "./scan-core.js";

export type { RepoScan } from "./scan-core.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "coverage",
  ".azx",
]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".sql", ".yml", ".yaml", ".toml", ".json", ".cfg", ".ini", ".txt", ".md",
]);

const MAX_FILES = 4000;
const MAX_BYTES = 256 * 1024;

/** Walk the repo collecting repo-relative paths of text files (bounded). */
function walk(root: string, dir: string, acc: string[]): void {
  if (acc.length >= MAX_FILES) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (acc.length >= MAX_FILES) return;
    const abs = join(dir, name);
    let st;
    try {
      // lstatSync (not statSync) so we can detect symlinks without following them.
      st = lstatSync(abs);
    } catch {
      continue;
    }
    // Do not follow symlinks: a symlinked dir/file could point outside the repo.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue;
      walk(root, abs, acc);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
      const isEnv = name === ".env" || name.startsWith(".env");
      const isDockerfile = name === "Dockerfile" || name.startsWith("Dockerfile");
      if (TEXT_EXT.has(ext) || isEnv || isDockerfile || name === "Pipfile") {
        acc.push(relative(root, abs));
      }
    }
  }
}

/** Read a repository and return the app info + raw signals (stage 0). */
export function readRepo(root: string): RepoScan {
  const acc: string[] = [];
  walk(root, root, acc);

  const files = new Map<string, string>();
  for (const rel of acc) {
    const key = rel.split(sep).join("/"); // forward-slash, machine-independent
    try {
      const abs = join(root, rel);
      const st = statSync(abs);
      if (st.isFile() && st.size <= MAX_BYTES) files.set(key, readFileSync(abs, "utf8"));
    } catch {
      // unreadable / too large — skip
    }
  }

  // Serialize a portable, machine-independent app name (directory basename only)
  // so committed output/goldens never bake in an absolute path (e.g. C:\Users\...).
  const appName = basename(root) || "app";
  return scanFileMap(appName, files);
}