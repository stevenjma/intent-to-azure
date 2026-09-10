import { test } from "node:test";
import assert from "node:assert/strict";

import { generateBicep } from "../src/bicep.js";
import { parseGuardrails } from "../src/guardrails.js";
import { plan } from "../src/plan.js";
import { runLocalDeploy, type AzRunner } from "../src/az-deploy.js";
import { runShip } from "../src/ship.js";
import type { AppIntent, AzurePlan } from "../src/types.js";

const baseIntent: AppIntent = {
  version: "0.1",
  app: { name: "hardening", root: "." },
  needs: [],
  signals: [],
  confirmations: [],
  meta: { generatedBy: "azx", generatedAt: "2026-01-01T00:00:00Z", stages: [] },
};

test("Bicep escapes every untrusted string sink", () => {
  const hostile = "x'${resourceGroup().id}\\path\nresource injected 'Microsoft.Storage/storageAccounts@2023-05-01' = {}";
  const p: AzurePlan = {
    region: hostile,
    resources: [{
      id: "evil",
      name: hostile,
      type: "Microsoft.CognitiveServices/accounts/deployments",
      service: "test",
      region: hostile,
      properties: { model: hostile, scale: { minReplicas: hostile, maxReplicas: hostile } },
      notes: [hostile],
    }],
    summary: [], confirmations: [], guardrailNotes: [], warnings: [],
    budget: { estimatedMonthlyUsd: hostile as unknown as number, currency: hostile, warnings: [], blocked: false },
    meta: { generatedBy: "azx", generatedAt: "2026-01-01T00:00:00Z", dryRun: true },
  };
  const bicep = generateBicep(p);
  assert.ok(!bicep.includes("\nresource injected"));
  assert.ok(bicep.includes("\\${resourceGroup().id}"));
  assert.ok(bicep.includes("\\\\path"));
  assert.ok(bicep.includes("x\\'\\${"));
  assert.match(bicep, /\\nresource injected/);
});

test("strict guardrails reject malformed YAML, invalid roots, values, and typos with a path", () => {
  for (const yaml of [
    "regions: [eastus2",
    "- eastus2",
    "skuTier: cheap",
    "budegt:\n  monthlyCapUsd: 1",
    "regions: []",
    "approvedModels: []",
    "approved_models: []",
  ]) {
    assert.throws(() => parseGuardrails(yaml, "repo/guardrails.yaml"), /repo\/guardrails\.yaml/);
  }
});

test("Anthropic and empty model plans create no Azure OpenAI account and remain blocked", () => {
  for (const options of [{ provider: "anthropic", models: ["claude-3-sonnet"] }, { provider: "openai", models: [] }]) {
    const intent = {
      ...baseIntent,
      needs: [{
        capability: "chat-model", confidence: "high" as const, rationale: "test", evidence: ["test"], options,
      }],
    };
    const p = plan(intent, { guardrails: { regions: ["eastus2"] } });
    assert.equal(p.resources.some((r) => r.type === "Microsoft.CognitiveServices/accounts"), false);
    assert.ok(p.confirmations.some((c) => c.id.startsWith("capability:chat-model:")));
  }
});

test("unknown future OpenAI model names remain deployable without unsafe substitution", () => {
  const intent = {
    ...baseIntent,
    needs: [{
      capability: "chat-model", confidence: "high" as const, rationale: "test", evidence: ["test"],
      options: { provider: "openai", models: ["gpt-future-2027"] },
    }],
  };
  const p = plan(intent, { guardrails: { regions: ["eastus2"] } });
  assert.equal(p.confirmations.length, 0);
  assert.equal(p.resources.filter((r) => r.type.includes("CognitiveServices")).length, 2);
  assert.equal(p.resources.find((r) => r.type.endsWith("/deployments"))?.properties?.model, "gpt-future-2027");
});

test("medium/low confirmations fail closed in local deploy and ship library APIs", () => {
  const p = plan(baseIntent);
  let calls = 0;
  const runner: AzRunner = (args) => {
    calls++;
    return {
      status: 0,
      stdout: args[0] === "account" && args[1] === "show"
        ? JSON.stringify({ id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" })
        : args[0] === "group" && args[1] === "exists"
          ? "true"
        : "{}",
      stderr: "",
    };
  };
  assert.throws(
    () => runLocalDeploy(p, { bicepPath: "main.bicep", resourceGroup: "rg-test", region: "eastus2" }, runner),
    /unresolved confirmation/,
  );
  assert.equal(calls, 0);
  assert.throws(() => runShip(baseIntent, p, "", {}, () => {}), /unresolved confirmation/);
  assert.doesNotThrow(() =>
    runLocalDeploy(
      p,
      {
        bicepPath: "main.bicep",
        resourceGroup: "rg-test",
        region: "eastus2",
        acceptAssumptions: true,
      },
      runner,
    ),
  );
});

test("block budgets fail closed for unbounded consumption", () => {
  for (const capability of ["web-compute", "object-storage", "search-index", "transactional-relational"]) {
    const intent = {
      ...baseIntent,
      needs: [{
        capability, confidence: "high" as const, rationale: "test", evidence: ["test"],
      }],
    };
    const p = plan(intent, {
      guardrails: { regions: ["eastus2"], budget: { monthlyCapUsd: 1000, onExceed: "block" } },
    });
    assert.equal(p.budget.blocked, true, `${capability} must not claim an enforceable spend cap`);
    assert.ok(p.budget.warnings.some((w) => /cannot prove/.test(w)));
  }
});

test("global service names obey Azure constraints and include deterministic collision suffixes", () => {
  const intent = {
    ...baseIntent,
    app: { ...baseIntent.app, name: "A VERY long !! application name ".repeat(5) },
    needs: [{
      capability: "object-storage", confidence: "high" as const, rationale: "test", evidence: ["test"],
    }],
  };
  const first = plan(intent, { guardrails: { regions: ["eastus2"] } });
  const second = plan(intent, { guardrails: { regions: ["eastus2"] } });
  const name = first.resources.find((r) => r.type === "Microsoft.Storage/storageAccounts")!.name;
  assert.match(name, /^[a-z0-9]{3,24}$/);
  assert.equal(name, second.resources.find((r) => r.type === "Microsoft.Storage/storageAccounts")!.name);
});
