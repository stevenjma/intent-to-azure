/**
 * Unit guard (FIX 4): the resolved region is slugified (lowercase, [a-z0-9]
 * only) before it reaches the plan object and the Bicep preview, so a dirty
 * guardrail region can't inject quotes/whitespace/newlines into the output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { resolveRepo, plan, slugifyRegion } from "../src/index.js";

test("slugifyRegion strips everything but [a-z0-9] and lowercases", () => {
  assert.equal(slugifyRegion("East US 2"), "eastus2");
  assert.equal(slugifyRegion("  westeurope\n"), "westeurope");
  assert.equal(slugifyRegion("east'us; DROP"), "eastusdrop");
  assert.equal(slugifyRegion("WESTUS2"), "westus2");
});

test("a dirty guardrail region is sanitized in the plan", () => {
  const root = fileURLToPath(new URL("../../examples/contoso-marketing", import.meta.url));
  const { intent } = resolveRepo(root, { now: () => new Date("2024-01-01T00:00:00.000Z") });

  const resolved = plan(intent, {
    now: () => new Date("2024-01-01T00:00:00.000Z"),
    guardrails: { regions: ["West Europe!!\n"] },
  });

  assert.equal(resolved.region, "westeurope");
  // And nothing dangerous leaks: no quote/whitespace in the resolved region.
  assert.match(resolved.region, /^[a-z0-9]+$/);
});
