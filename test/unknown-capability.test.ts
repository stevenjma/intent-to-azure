/**
 * Contract test for the plan() open-capability path (deep-review RISK A).
 *
 * azx's own read-repo pipeline only ever emits KNOWN capabilities, so an
 * unknown capability can only arrive when a hand-authored / third-party App
 * Intent (or the future MCP `plan` tool) calls plan(intent) directly. SPEC §4
 * promises such a capability is "surfaced as a confirm card rather than
 * fail" — never silently dropped. These tests feed plan() a hand-built intent
 * and assert exactly that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { plan } from "../src/index.js";
import type { AppIntent, Need } from "../src/types.js";

const FIXED = new Date("2024-01-01T00:00:00.000Z");

/** A minimal, deterministic hand-authored App Intent (NOT via read-repo). */
function handAuthoredIntent(needs: Need[]): AppIntent {
  return {
    version: "0.1",
    app: { name: "custom-app", root: "custom-app" },
    needs,
    signals: [],
    confirmations: [],
    meta: { generatedBy: "azx", generatedAt: FIXED.toISOString(), stages: ["hand-authored"] },
  };
}

function need(capability: string, over: Partial<Need> = {}): Need {
  return { capability, confidence: "high", rationale: "", evidence: [], ...over };
}

test("plan(): unknown capability surfaces as an 'unresolved' confirm card, never dropped", () => {
  const intent = handAuthoredIntent([
    need("web-compute"),
    need("x-custom-cache", { confidence: "high" }),
  ]);

  const resolved = plan(intent, { now: () => FIXED });

  const card = resolved.confirmations.find((c) => c.capability === "x-custom-cache");
  assert.ok(card, "expected a confirm card for the unknown capability 'x-custom-cache'");
  assert.equal(card?.id, "capability:x-custom-cache:unresolved");
  assert.match(card!.question, /x-custom-cache/);
  assert.match(card!.question, /no resolver/i);

  // The unknown capability produced no Azure resource (honest — never guessed).
  const unknownRes = resolved.resources.some((r) => r.capability === "x-custom-cache");
  assert.equal(unknownRes, false, "unknown capability must not fabricate a resource");
});

test("plan(): recognized capabilities never gain a spurious 'unresolved' confirm", () => {
  const intent = handAuthoredIntent([
    need("web-compute"),
    need("transactional-relational"),
    need("object-storage"),
  ]);

  const resolved = plan(intent, { now: () => FIXED });

  const spurious = resolved.confirmations.filter((c) => c.id.endsWith(":unresolved"));
  assert.equal(spurious.length, 0, `no unresolved confirms expected, got: ${JSON.stringify(spurious)}`);

  // And the known capabilities did resolve to real resources.
  assert.ok(resolved.resources.some((r) => r.capability === "web-compute"));
  assert.ok(resolved.resources.some((r) => r.capability === "transactional-relational"));
});
