/**
 * Regression guard (FIX 2): the engine must never bake a machine-specific
 * absolute path into its serialized output. We run the full offline pipeline on
 * every fixture, serialize `intent + bicep`, and assert the string matches none
 * of the common absolute-path shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { resolveRepo } from "../src/index.js";

const FIXTURES = ["contoso-marketing", "vector-search-api", "django-notes"] as const;

const ABSOLUTE_PATH_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["windows drive path", /[A-Za-z]:\\/],
  ["/Users/", /\/Users\//],
  ["/home/", /\/home\//],
  ["/root/", /\/root\//],
];

for (const name of FIXTURES) {
  test(`no-absolute-paths: ${name}`, () => {
    const root = fileURLToPath(new URL(`../../examples/${name}`, import.meta.url));
    const { intent, bicep } = resolveRepo(root, { now: () => new Date("2024-01-01T00:00:00.000Z") });
    const serialized = JSON.stringify(intent) + "\n" + bicep;

    for (const [label, re] of ABSOLUTE_PATH_PATTERNS) {
      assert.ok(
        !re.test(serialized),
        `${name}: serialized output leaked an absolute path (${label}: ${re})`,
      );
    }
    // Positive check: app.root is the portable basename, not a path.
    assert.equal(intent.app.root, name);
  });
}
