/**
 * Safety guard (FIX 5): the engine emits env-var KEY names as signals, never
 * their VALUES. We build a temp repo whose `.env` holds a fake secret value,
 * run the full pipeline, serialize everything, and assert the secret value is
 * absent while the key name may appear.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRepo } from "../src/index.js";

const SECRET_KEY = "OPENAI_API_KEY";
const SECRET_VALUE = "sk-TEST_DO_NOT_LEAK_0000";

test("env values never appear in output; key names may", () => {
  const dir = mkdtempSync(join(tmpdir(), "azx-env-safety-"));
  try {
    writeFileSync(
      join(dir, ".env"),
      `${SECRET_KEY}=${SECRET_VALUE}\nDATABASE_URL=postgres://localhost:5432/app\n`,
      "utf8",
    );
    // A trivial package.json so the repo scans as a real app.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "env-safety-fixture" }), "utf8");

    const { intent, plan, bicep } = resolveRepo(dir, {
      now: () => new Date("2024-01-01T00:00:00.000Z"),
    });
    const serialized = JSON.stringify({ intent, plan }) + "\n" + bicep;

    assert.ok(
      !serialized.includes(SECRET_VALUE),
      "the secret VALUE must never appear in serialized output",
    );
    // The KEY name showing up (as a detected signal) is expected and fine.
    assert.ok(
      serialized.includes(SECRET_KEY),
      "expected the env KEY name to surface as a signal",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
