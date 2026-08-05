/**
 * Scaffold + ship tests — the real-deploy bridge.
 *
 * `buildScaffold` and `shipSteps` are pure/offline: they turn a resolved plan
 * into a deployable repo tree (Bicep + CI/CD pipeline) and the ordered git/gh
 * commands that would make it a live repo. `runShip` is the only side-effecting
 * path; here we exercise it with a fake {@link CommandRunner} so no real git/gh
 * runs, and assert the files land on disk.
 *
 * All fully offline — azx never calls Azure; the real deploy lives in the emitted
 * workflow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";

import { resolveRepo } from "../src/index.js";
import { buildScaffold } from "../src/scaffold.js";
import { shipSteps, runShip, assertEmptyOutDir, type ShipStep } from "../src/ship.js";
import { fileURLToPath } from "node:url";

const FIXED = new Date("2024-01-01T00:00:00.000Z");

function fixture(name: string): string {
  return fileURLToPath(new URL(`../../examples/${name}`, import.meta.url));
}

function build(name: string) {
  return resolveRepo(fixture(name), { now: () => FIXED });
}

test("buildScaffold emits a complete, deterministic repo tree", () => {
  const { intent, plan, bicep } = build("contoso-marketing");
  const files = buildScaffold(intent, plan, bicep);
  const paths = files.map((f) => f.path);

  for (const expected of [
    "infra/main.bicep",
    ".github/workflows/deploy.yml",
    "README.md",
    ".azx/plan.json",
    ".gitignore",
  ]) {
    assert.ok(paths.includes(expected), `expected scaffold to contain ${expected}`);
  }

  // Deterministic ordering (sorted) so goldens/diffs are stable.
  assert.deepEqual(paths, [...paths].sort());

  // The Bicep file is the generated template verbatim.
  assert.equal(files.find((f) => f.path === "infra/main.bicep")?.content, bicep);
});

test("deploy.yml is valid YAML with what-if gate then real deploy", () => {
  const { intent, plan, bicep } = build("contoso-marketing");
  const wf = buildScaffold(intent, plan, bicep).find(
    (f) => f.path === ".github/workflows/deploy.yml",
  )!.content;

  const doc = parseYaml(wf) as any;
  assert.equal(doc.name, "deploy");
  // OIDC permission is required for azure/login.
  assert.equal(doc.permissions["id-token"], "write");
  // Two jobs: the what-if gate and the real deploy that depends on it.
  assert.ok(doc.jobs["what-if"], "expected a what-if job");
  assert.ok(doc.jobs.deploy, "expected a deploy job");
  assert.deepEqual(doc.jobs.deploy.needs, "what-if");
  // Both jobs skip cleanly until OIDC is provisioned (guarded on AZURE_CLIENT_ID),
  // so the first push doesn't red-X before setup-azure-oidc.sh has run.
  assert.match(String(doc.jobs["what-if"].if), /AZURE_CLIENT_ID/);
  assert.match(String(doc.jobs.deploy.if), /AZURE_CLIENT_ID/);
  // The real deploy is gated behind an approvable environment.
  assert.equal(doc.jobs.deploy.environment, "production");
  // The real deploy actually creates resources.
  const deployRun = JSON.stringify(doc.jobs.deploy.steps);
  assert.ok(deployRun.includes("az deployment group create"), "deploy must create resources");
});

test("Postgres plans wire a PG_ADMIN_PASSWORD secret; non-Postgres plans do not", () => {
  const pg = build("contoso-marketing");
  const pgWf = buildScaffold(pg.intent, pg.plan, pg.bicep).find(
    (f) => f.path === ".github/workflows/deploy.yml",
  )!.content;
  assert.ok(pgWf.includes("PG_ADMIN_PASSWORD"), "Postgres plan should pass an admin password");
  // Still valid YAML with the secret wiring.
  parseYaml(pgWf);

  // Synthesize a Postgres-free plan by dropping the DB resource.
  const noDb = {
    ...pg.plan,
    resources: pg.plan.resources.filter(
      (r) => r.type !== "Microsoft.DBforPostgreSQL/flexibleServers",
    ),
  };
  const noDbWf = buildScaffold(pg.intent, noDb, pg.bicep).find(
    (f) => f.path === ".github/workflows/deploy.yml",
  )!.content;
  assert.ok(!noDbWf.includes("PG_ADMIN_PASSWORD"), "non-Postgres plan must omit the DB secret");
  parseYaml(noDbWf);
});

test("Postgres pipeline passes the secret via a params file, never inline on argv", () => {
  const pg = build("contoso-marketing");
  const wf = buildScaffold(pg.intent, pg.plan, pg.bicep).find(
    (f) => f.path === ".github/workflows/deploy.yml",
  )!.content;
  // The secret is written to a params file and referenced with @-file...
  assert.ok(wf.includes("--parameters @azx.params.json"), "must reference a params file");
  assert.ok(wf.includes("jq -n --arg p"), "must build the params file from the secret via jq");
  // ...guarded by a fail-fast check so an unset secret errors before burning an approval...
  assert.ok(
    wf.includes('[ -n "$PG_ADMIN_PASSWORD" ]'),
    "must fail fast when the PG_ADMIN_PASSWORD secret is unset",
  );
  // ...and NEVER interpolated unquoted onto the az command line.
  assert.ok(
    !wf.includes("postgresAdminPassword=$PG_ADMIN_PASSWORD"),
    "must not put the secret on argv (word-splitting / injection risk)",
  );
  parseYaml(wf);
});

test("scaffold ships a repo-parameterized OIDC setup script", () => {
  const { intent, plan, bicep } = build("django-notes");
  const files = buildScaffold(intent, plan, bicep);
  const script = files.find((f) => f.path === "scripts/setup-azure-oidc.sh");
  assert.ok(script, "expected scripts/setup-azure-oidc.sh to be shipped");
  // It must federate the exact two subjects deploy.yml authenticates as.
  assert.ok(script!.content.includes("repo:${REPO}:ref:refs/heads/main"), "federates main branch");
  assert.ok(
    script!.content.includes("repo:${REPO}:environment:production"),
    "federates the production environment",
  );
  // And resolve the repo it runs inside (not hardcoded to azx's own repo).
  assert.ok(script!.content.includes("gh repo view --json nameWithOwner"), "resolves the current repo");
  // RBAC must be race-hardened: assign by SP object id (skips the Graph lookup that
  // races a fresh SP), retry through Entra replication, and fail loud (never swallow).
  assert.ok(
    script!.content.includes("--assignee-object-id") &&
      script!.content.includes("--assignee-principal-type ServicePrincipal"),
    "role assignment uses SP object id + principal type",
  );
  assert.ok(/sleep \d+/.test(script!.content), "role assignment retries with a backoff sleep");
  assert.ok(
    script!.content.includes("could not assign Contributor"),
    "role assignment failure is surfaced, not swallowed",
  );
  // Federated-credential creation must also fail loud (not swallow all errors as
  // "already present") — only a same-name conflict counts as success.
  assert.ok(
    script!.content.includes("FederatedIdentityCredentialWithSameNameExists"),
    "federated-credential errors fail loud except already-exists",
  );
  assert.ok(
    script!.content.includes("could not create federated credential"),
    "federated-credential failure is surfaced, not swallowed",
  );
});

test("scaffold flags a partial-deploy ledger instead of claiming a clean no-op", () => {
  const { intent, plan, bicep } = build("contoso-marketing");
  const base = {
    generatedBy: "azx" as const,
    deployedAt: "2026-01-01T00:00:00Z",
    deploymentName: "azx-1",
    resourceGroup: "rg-contoso-marketing",
    region: "swedencentral",
    resources: [],
  };
  const readmeFor = (ledger: typeof base & { partial?: boolean }) =>
    buildScaffold(intent, plan, bicep, { ledger }).find((f) => f.path === "README.md")!.content;

  const clean = readmeFor(base);
  assert.ok(clean.includes("no infrastructure changes"), "a clean ledger keeps the no-op adoption note");

  const partial = readmeFor({ ...base, partial: true });
  assert.ok(partial.includes("PARTIAL"), "a partial ledger is flagged as partial");
  assert.ok(partial.includes("will show creates"), "partial note warns the first what-if shows creates");
  assert.ok(
    !partial.includes("no infrastructure changes"),
    "a partial ledger must not claim a clean no-op",
  );
});

test("shipSteps: no repo → git-only; --create-repo adds gh create; --deploy adds trigger", () => {
  const { intent, plan, bicep } = build("django-notes");

  const local = shipSteps(intent, plan, bicep);
  assert.deepEqual(local.steps.map((s) => s.cmd), ["git", "git", "git"]);

  const created = shipSteps(intent, plan, bicep, { repo: "acme/notes" });
  const ghCreate = created.steps.find((s) => s.cmd === "gh" && s.args[1] === "create");
  assert.ok(ghCreate, "expected a `gh repo create` step");
  assert.ok(ghCreate!.args.includes("acme/notes"));
  assert.ok(ghCreate!.args.includes("--private"), "defaults to a private repo");
  assert.ok(ghCreate!.args.includes("--push"));
  // No deploy trigger unless asked.
  assert.ok(!created.steps.some((s) => s.args.includes("workflow")));

  const shipped = shipSteps(intent, plan, bicep, { repo: "acme/notes", deploy: true });
  const trigger = shipped.steps.find((s) => s.cmd === "gh" && s.args[1] === "run");
  assert.ok(trigger, "expected a `gh workflow run` step when --deploy is set");
  assert.deepEqual(trigger!.args, ["workflow", "run", "deploy.yml", "--repo", "acme/notes"]);

  const publicRepo = shipSteps(intent, plan, bicep, { repo: "acme/notes", visibility: "public" });
  assert.ok(
    publicRepo.steps.some((s) => s.args.includes("--public")),
    "visibility: public should pass --public",
  );
});

test("neither pipeline job runs `az group create` (RG is pre-created, principal is RG-scoped)", () => {
  const { intent, plan, bicep } = build("contoso-marketing");
  const wf = buildScaffold(intent, plan, bicep).find(
    (f) => f.path === ".github/workflows/deploy.yml",
  )!.content;
  const doc = parseYaml(wf) as any;
  const allSteps = JSON.stringify([doc.jobs["what-if"].steps, doc.jobs.deploy.steps]);
  assert.ok(
    !allSteps.includes("az group create"),
    "pipeline must not create resource groups — the RG-scoped principal can't, and setup pre-creates it",
  );
});

test("setup script pre-creates the RG and scopes Contributor to it, not the subscription", () => {
  const { intent, plan, bicep } = build("contoso-marketing");
  const script = buildScaffold(intent, plan, bicep).find(
    (f) => f.path === "scripts/setup-azure-oidc.sh",
  )!.content;
  // Bakes the concrete RG + region so the human running it targets the same place.
  assert.ok(/RESOURCE_GROUP="rg-contoso-marketing"/.test(script), "bakes the resolved resource group");
  assert.ok(/LOCATION="/.test(script), "bakes the resolved region");
  // Pre-creates the RG as the human (full rights) before the RG-scoped grant.
  assert.ok(script.includes('az group create -n "$RESOURCE_GROUP"'), "pre-creates the resource group");
  // Contributor is scoped to the RG, NOT the whole subscription.
  assert.ok(
    script.includes("/subscriptions/${SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}"),
    "Contributor scope is the resource group",
  );
  assert.ok(
    !/scope="\/subscriptions\/\$\{SUBSCRIPTION\}"/.test(script),
    "must not grant Contributor at subscription scope",
  );
  // Pins the subscription so the RG + role assignment can't land in a stray account.
  assert.ok(script.includes('az account set --subscription "$SUBSCRIPTION"'), "pins the subscription");
});

test("setup script refuses implicit Entra app reuse and supports explicit --app-id", () => {
  const { intent, plan, bicep } = build("contoso-marketing");
  const script = buildScaffold(intent, plan, bicep).find(
    (f) => f.path === "scripts/setup-azure-oidc.sh",
  )!.content;
  // An --app-id flag exists for intentional reuse.
  assert.ok(script.includes("--app-id) APP_ID_ARG="), "parses an explicit --app-id flag");
  // When no --app-id is given, an app already matching the display name is a hard stop
  // (reuse could inherit stale credentials/roles), not a silent `[0]` pickup.
  assert.ok(
    !script.includes("[0].appId"),
    "must not silently reuse the first app matching the display name",
  );
  assert.ok(
    script.includes("refusing to reuse an existing app"),
    "refuses implicit reuse with an actionable message",
  );
  assert.ok(script.includes("exit 1"), "collision is a hard failure");
});

test("setup script defaults the subscription from the deploy ledger when present", () => {
  const { intent, plan, bicep } = build("contoso-marketing");
  const ledger = {
    generatedBy: "azx" as const,
    deployedAt: "2026-01-01T00:00:00Z",
    subscriptionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    resourceGroup: "rg-contoso-marketing",
    region: "swedencentral",
    deploymentName: "azx-1",
    resources: [],
  };
  const withLedger = buildScaffold(intent, plan, bicep, { ledger }).find(
    (f) => f.path === "scripts/setup-azure-oidc.sh",
  )!.content;
  assert.ok(
    withLedger.includes('DEFAULT_SUBSCRIPTION="3f2504e0-4f89-41d3-9a0c-0305e82c3301"'),
    "bakes the ledger's subscription as the default",
  );
  // Without a ledger, the default is empty (falls back to the current az account).
  const noLedger = buildScaffold(intent, plan, bicep).find(
    (f) => f.path === "scripts/setup-azure-oidc.sh",
  )!.content;
  assert.ok(noLedger.includes('DEFAULT_SUBSCRIPTION=""'), "no ledger → empty default subscription");
});

test("shipSteps stages only the generated files, never `git add -A`", () => {
  const { intent, plan, bicep } = build("django-notes");
  const { files, steps } = shipSteps(intent, plan, bicep);
  const add = steps.find((s) => s.cmd === "git" && s.args[0] === "add")!;
  assert.ok(!add.args.includes("-A"), "must not blanket-stage the working tree");
  assert.equal(add.args[1], "--", "stages by explicit pathspec after a `--` separator");
  // Every generated file is staged explicitly; nothing else can be.
  const staged = add.args.slice(2);
  assert.deepEqual([...staged].sort(), files.map((f) => f.path).sort());
});

test("runShip refuses to publish into a non-empty directory", () => {
  const { intent, plan, bicep } = build("django-notes");
  const dir = mkdtempSync(join(tmpdir(), "azx-ship-nonempty-"));
  try {
    writeFileSync(join(dir, "stray-secret.txt"), "do not publish me");
    assert.throws(
      () => runShip(intent, plan, bicep, { outDir: dir, repo: "acme/notes" }, () => {}),
      /already exists and is not empty/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assertEmptyOutDir guards the dry-run --out writer the same way as runShip", () => {
  // The CLI's dry-run `--out` writer calls this same guard before writing a scaffold,
  // so a stray/secret-bearing directory can't be silently overwritten there either.
  const dir = mkdtempSync(join(tmpdir(), "azx-out-guard-"));
  try {
    // Empty dir (and a brand-new path) are both fine.
    assert.doesNotThrow(() => assertEmptyOutDir(dir));
    assert.doesNotThrow(() => assertEmptyOutDir(join(dir, "does-not-exist-yet")));
    // A non-empty dir is refused.
    writeFileSync(join(dir, "keep.txt"), "existing file");
    assert.throws(() => assertEmptyOutDir(dir), /already exists and is not empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runShip writes the scaffold to disk and runs each step in that dir", () => {
  const { intent, plan, bicep } = build("django-notes");
  const dir = mkdtempSync(join(tmpdir(), "azx-ship-"));
  try {
    const ran: Array<{ step: ShipStep; cwd: string }> = [];
    const fakeRunner = (step: ShipStep, cwd: string) => {
      ran.push({ step, cwd });
    };

    const result = runShip(intent, plan, bicep, { outDir: dir, repo: "acme/notes", deploy: true }, fakeRunner);

    assert.equal(result.executed, true);
    // Every scaffold file landed on disk.
    for (const f of result.files) {
      const abs = join(dir, f.path);
      assert.ok(existsSync(abs), `expected ${f.path} written`);
      assert.equal(readFileSync(abs, "utf8"), f.content);
    }
    // Every planned step was run, in the scaffold dir, in order.
    assert.deepEqual(ran.map((r) => r.step), result.steps);
    for (const r of ran) assert.equal(r.cwd, result.outDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
