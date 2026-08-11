/**
 * Regression guard (DR-003): the GitHub OAuth scope string is duplicated across a
 * static SPA, a YAML generator, and a separate Cloudflare Worker that share no build
 * step, so it cannot be a literal single source. The just-shipped missing-`workflow`
 * bug was exactly a drift between these copies. This test pins them together: every
 * copy must equal the canonical scope string, so any future change to one that isn't
 * mirrored to the others fails CI instead of silently 404ing a customer's pipeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CANONICAL_SCOPES = "repo workflow read:user";

// Each copy, with the exact substring that must contain the canonical scopes.
const COPIES: ReadonlyArray<readonly [string, string]> = [
  ["web/config.example.js", `githubScopes: "${CANONICAL_SCOPES}"`],
  ["web/github.js", `"${CANONICAL_SCOPES}"`],
  ["web/worker/github-oauth-worker.js", `"${CANONICAL_SCOPES}"`],
  // pages.yml drives production config.js; the operator-overridable default lives here.
  [".github/workflows/pages.yml", `\${GH_SCOPES:-${CANONICAL_SCOPES}}`],
];

for (const [relPath, expected] of COPIES) {
  test(`oauth-scopes-consistent: ${relPath}`, () => {
    const abs = fileURLToPath(new URL(`../../${relPath}`, import.meta.url));
    const source = readFileSync(abs, "utf8");
    assert.ok(
      source.includes(expected),
      `${relPath}: OAuth scope string drifted — expected to find ${JSON.stringify(
        expected,
      )}. All copies must equal the canonical ${JSON.stringify(CANONICAL_SCOPES)}.`,
    );
  });
}
