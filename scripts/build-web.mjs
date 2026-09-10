/**
 * build-web — assemble the static SPA's engine assets.
 *
 * The Pages SPA is zero-build: it imports the tsc-compiled engine directly as ES
 * modules. This script (run after `tsc`) copies the browser-safe compiled modules
 * from `dist/src/` into `web/engine/` so `web/` is a self-contained static site that
 * GitHub Pages can serve as-is. It also fails loud if any copied module transitively
 * imports a `node:` builtin — that would mean someone reintroduced a Node dependency
 * into the browser graph.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const distSrc = resolve("dist/src");
const outDir = resolve("web/engine");

// The node-free browser graph, rooted at web-engine.js. Keep in sync with src/web-engine.ts.
const ENTRY = "web-engine";

/** Follow relative imports from ENTRY, collecting the transitive module set and
 * rejecting any `node:` import. */
function collect(entry) {
  const seen = new Set();
  const nodePulls = [];
  const unsupportedDynamicImports = [];
  const walk = (mod) => {
    if (seen.has(mod)) return;
    seen.add(mod);
    let text;
    try {
      text = readFileSync(join(distSrc, mod + ".js"), "utf8");
    } catch {
      throw new Error(`build-web: missing compiled module dist/src/${mod}.js — run \`tsc\` first.`);
    }
    const specs = new Set();
    const patterns = [
      /\b(?:import|export)\s+[^"'()]*?\sfrom\s*["']([^"']+)["']/g,
      /\bimport\s*["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text))) specs.add(match[1]);
    }

    const dynamicImports = [...text.matchAll(/\bimport\s*\(\s*([^"'`\s][^)]*)\)/g)];
    for (const match of dynamicImports) {
      unsupportedDynamicImports.push(`${mod}.js -> import(${match[1].trim()})`);
    }

    for (const spec of specs) {
      if (spec.startsWith("node:")) {
        nodePulls.push(`${mod}.js -> ${spec}`);
      } else if (spec.startsWith("./")) {
        walk(spec.replace(/^\.\//, "").replace(/\.js$/, ""));
      }
    }
  };
  walk(entry);
  return { modules: [...seen], nodePulls, unsupportedDynamicImports };
}

const { modules, nodePulls, unsupportedDynamicImports } = collect(ENTRY);

if (nodePulls.length > 0 || unsupportedDynamicImports.length > 0) {
  console.error("build-web: FAILED — browser engine graph pulls Node builtins:");
  for (const p of nodePulls) console.error("  " + p);
  for (const p of unsupportedDynamicImports) console.error("  unresolved dynamic import: " + p);
  console.error(
    "\nA browser-safe module imported a `node:` builtin or used a dynamic import that\n" +
      "cannot be audited at build time. Keep imports literal, or split Node adapters\n" +
      "(fs/child_process) from the browser-safe core.",
  );
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const mod of modules) {
  const src = join(distSrc, mod + ".js");
  writeFileSync(join(outDir, mod + ".js"), readFileSync(src));
  copied++;
}

console.log(`build-web: copied ${copied} node-free engine modules to web/engine/`);
console.log(`  modules: ${modules.sort().join(", ")}`);
