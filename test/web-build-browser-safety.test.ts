import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("build-web checks browser-unsafe static, side-effect, and dynamic imports", () => {
  const fromDist = /[\\/]dist[\\/]test[\\/]/.test(fileURLToPath(import.meta.url));
  const path = fileURLToPath(new URL(fromDist ? "../../scripts/build-web.mjs" : "../scripts/build-web.mjs", import.meta.url));
  const build = readFileSync(path, "utf8");
  assert.match(build, /import\|export/);
  assert.match(build, /import\\s\*\\\(/);
  assert.match(build, /unsupportedDynamicImports/);
  assert.match(build, /spec\.startsWith\("node:"\)/);
});
