/**
 * Golden + schema-conformance tests for the azx dry-run engine.
 *
 * For each fixture under `examples/` we run the full offline pipeline
 * (read-repo → extract-intent → plan → generate-bicep via {@link resolveRepo})
 * with a pinned clock, then:
 *
 *   1. snapshot `{ intent, plan, bicep }` to `test/golden/<fixture>.json`
 *      (regenerate with `UPDATE_GOLDENS=1 npm test`), and
 *   2. validate the emitted App Intent against `app-intent.schema.json`
 *      (JSON Schema draft 2020-12), plus a few capability invariants.
 *
 * The engine touches no network, so these run fully offline. The only
 * machine-specific value in the output is `intent.app.root` (an absolute
 * path); we normalize it to `examples/<fixture>` so goldens are portable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { resolveRepo } from "../src/index.js";
import type { IntentResponse } from "../src/types.js";

// ajv ships CJS; load its draft-2020-12 entrypoint via require to sidestep
// ESM default-interop quirks. `strict: false` keeps unknown `format`
// annotations non-fatal (we don't ship ajv-formats).
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");

const FIXED = new Date("2024-01-01T00:00:00.000Z");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

const FIXTURES = ["contoso-marketing", "vector-search-api", "django-notes"] as const;
type Fixture = (typeof FIXTURES)[number];

type Snapshot = IntentResponse & { bicep: string };

function repoRoot(name: Fixture): string {
  return fileURLToPath(new URL(`../../examples/${name}`, import.meta.url));
}
function goldenPath(name: Fixture): string {
  return fileURLToPath(new URL(`../../test/golden/${name}.json`, import.meta.url));
}
function schemaPath(): string {
  return fileURLToPath(new URL("../../app-intent.schema.json", import.meta.url));
}

/** Run the full pipeline with a pinned clock and a portable app.root. */
function build(name: Fixture): Snapshot {
  const res = resolveRepo(repoRoot(name), { now: () => FIXED });
  // Normalize the one absolute path so goldens are machine-independent.
  res.intent.app.root = `examples/${name}`;
  return res;
}

/** JSON round-trip so comparisons ignore `undefined`/key-order like the file. */
function normalize<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

for (const name of FIXTURES) {
  test(`golden: ${name}`, () => {
    const snapshot = normalize<Snapshot>(build(name));
    const file = goldenPath(name);

    if (UPDATE || !existsSync(file)) {
      writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
      if (!UPDATE) {
        // First-ever run created the baseline; nothing to compare against yet.
        return;
      }
    }

    const expected = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(snapshot, expected);
  });
}

test("app-intent.schema.json validates every emitted intent", () => {
  const schema = JSON.parse(readFileSync(schemaPath(), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);

  for (const name of FIXTURES) {
    const { intent } = build(name);
    const ok = validate(intent);
    assert.ok(ok, `${name} intent failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`);
  }
});

test("contoso-marketing: guardrail-pinned happy path, zero confirmations", () => {
  const { intent, plan } = build("contoso-marketing");
  // 4 capabilities: web-compute, transactional-relational, chat-model, object-storage.
  assert.equal(intent.needs.length, 4);
  // Guardrail pins the region and allow-lists the model → nothing to confirm.
  assert.equal(plan.confirmations.length, 0);
  assert.equal(plan.region, "swedencentral");
  assert.ok(plan.guardrailNotes.length > 0, "expected guardrail notes");
  // Sponsorship subscription → classified as such, with a burn warning.
  assert.equal(plan.budget?.classification, "sponsorship");
  assert.ok((plan.budget?.warnings.length ?? 0) > 0, "expected a sponsorship burn warning");
});

test("vector-search-api: pgvector stays in Postgres, no AI Search, confirmations raised", () => {
  const { intent, plan } = build("vector-search-api");
  // Single-signal / ambiguous items become confirm cards.
  assert.equal(plan.confirmations.length, 3);
  // transactional-relational carries the pgvector option.
  const rel = intent.needs.find((n) => n.capability === "transactional-relational");
  assert.ok(rel, "expected a transactional-relational need");
  assert.equal(rel?.options?.pgvector, true);
  // pgvector keeps vectors in Postgres → we must NOT provision Azure AI Search.
  const hasSearch = plan.resources.some((r) => r.type.includes("Search/searchServices"));
  assert.equal(hasSearch, false, "pgvector path must not create Azure AI Search");
});

test("django-notes: non-AI baseline, budget absent, region-only confirmation", () => {
  const { intent, plan } = build("django-notes");
  // web-compute + transactional-relational only.
  assert.equal(intent.needs.length, 2);
  assert.equal(intent.needs.some((n) => n.capability === "chat-model"), false);
  // No `.azx/subscription.json` in this fixture → no budget context.
  assert.equal(intent.budget, undefined);
  // The only open question is the default region.
  assert.equal(plan.confirmations.length, 1);
  assert.equal(plan.confirmations[0]?.id, "region");
});
