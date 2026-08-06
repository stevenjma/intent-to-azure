import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { readRepo } from "../src/read-repo.js";
import { extractIntent } from "../src/extract-intent.js";
import { plan } from "../src/plan.js";
import { generateArmTemplate } from "../src/arm-template.js";
import { API_VERSIONS } from "../src/bicep.js";

const APPS_DIR = fileURLToPath(new URL("../../test/e2e/apps", import.meta.url));

function resolve(appDir: string) {
  const scan = readRepo(`${APPS_DIR}/${appDir}`);
  const intent = extractIntent(scan);
  return plan(intent);
}

const APPS = ["next-blob-storage", "next-minimal", "next-openai", "next-prisma-postgres"];

for (const app of APPS) {
  test(`ARM template mirrors the plan for ${app}`, () => {
    const p = resolve(app);
    const tpl = generateArmTemplate(p);

    // Well-formed deployment template.
    assert.equal(tpl.contentVersion, "1.0.0.0");
    assert.match(tpl.$schema, /deploymentTemplate\.json/);
    assert.ok(Array.isArray(tpl.resources));

    // One ARM resource per plan resource, same types, pinned api-versions.
    assert.equal(tpl.resources.length, p.resources.length);
    for (const r of tpl.resources) {
      assert.ok(r.type && r.name, "resource has type + name");
      const expected = API_VERSIONS[r.type];
      if (expected) assert.equal(r.apiVersion, expected, `${r.type} api-version pinned`);
      // Every dependsOn entry is a resourceId() expression, never a bare symbol.
      for (const d of r.dependsOn ?? []) {
        assert.match(d, /^\[resourceId\(/, `dependsOn is a resourceId expr: ${d}`);
      }
    }

    // location is parameterized on every top-level (non-nested) resource.
    for (const r of tpl.resources) {
      const nested = r.type.split("/").length >= 3;
      if (!nested) assert.equal(r.location, "[parameters('location')]");
    }
  });
}

test("PostgreSQL plan yields a securestring password param and parameterized admin creds", () => {
  const p = resolve("next-prisma-postgres");
  const tpl = generateArmTemplate(p);

  const params = tpl.parameters as Record<string, { type?: string }>;
  assert.equal(params.postgresAdminPassword?.type, "securestring");
  assert.equal(params.postgresAdminLogin?.type, "string");

  const pg = tpl.resources.find((r) => r.type === "Microsoft.DBforPostgreSQL/flexibleServers");
  assert.ok(pg, "postgres resource present");
  const props = pg!.properties as Record<string, unknown>;
  assert.equal(props.administratorLogin, "[parameters('postgresAdminLogin')]");
  assert.equal(props.administratorLoginPassword, "[parameters('postgresAdminPassword')]");
  // The password literal must never be baked into the template.
  assert.doesNotMatch(JSON.stringify(tpl), /administratorLoginPassword"\s*:\s*"(?!\[parameters)/);
});

test("no PostgreSQL → no password parameters", () => {
  const p = resolve("next-minimal");
  const tpl = generateArmTemplate(p);
  const params = tpl.parameters as Record<string, unknown>;
  assert.equal(params.postgresAdminPassword, undefined);
  assert.equal(params.postgresAdminLogin, undefined);
});
