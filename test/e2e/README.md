# azx end-to-end harness

A genuinely end-to-end, **tinkerable** harness for azx (the offline App Intent
Service). It commits real, editable Next.js app trees, throws each one at azx, and
proves every stage with a **distinct gate** — so you can edit a fixture, re-run, and
form opinions about what azx actually produces.

It runs locally — offline gates by default, plus an **optional local what-if** that
reuses your `az login` (see below) — and in CI (`.github/workflows/e2e.yml`, which
runs the what-if gate via OIDC). It is intentionally **green today** even though azx
has two known codegen bugs — those are encoded as *expected* outcomes (see below).

---

## The four gates

| gate | what it proves | needs Azure creds? |
| --- | --- | --- |
| **analyzed**   | `azx plan --json` runs and emits valid JSON | no |
| **plan-match** | `intent.needs` + `plan.resources` (id+type) + region **exactly** match `expectations.json` | no |
| **compile**    | `az bicep build` on the emitted template succeeds | no |
| **what-if**    | `az deployment group what-if` against an ephemeral RG passes preflight | **yes** (BYO-Azure) |

**Contract:**
- **plan-match is the hard gate.** Any drift in needs, resource ids/types, or region
  fails the run. This is azx's deterministic core.
- **compile / what-if are reconciled against the *expected* outcome**, not against
  "must pass". A gate matching a documented known-issue is OK. A gate flipping the
  *good* way (e.g. compile starts passing) is a **hard fail on purpose** — that means
  an azx bug got fixed and `expectations.json` must be updated to track reality.
- **what-if observed as `skip`** (no creds, or template didn't compile) is always
  neutral — the harness stays green without an Azure subscription.

---

## Fixtures

All under `test/e2e/apps/`, region `eastus2`, no guardrails file. Each is a real,
hand-authored Next.js tree you can edit.

| fixture | trigger | adds capability | resources | compile | what-if |
| --- | --- | --- | --- | --- | --- |
| `next-minimal`         | `next` dep + `next.config.mjs` | web-compute | app-env, web | ✅ pass | ❌ fail (bug2) |
| `next-prisma-postgres` | `prisma/schema.prisma` (postgresql) | + transactional-relational | + postgres, postgres-db | ✅ pass | ❌ fail (bug2) |
| `next-openai`          | `app/api/chat/route.ts` (gpt-4o) | + chat-model | + openai, openai-deploy-gpt-4o | ❌ fail (bug1) | — n/a |
| `next-blob-storage`    | `lib/blob.ts` (`BlobServiceClient`) | + object-storage | + storage, blob | ✅ pass | ❌ fail (bug2) |

`expectations.json` is the source of truth and was **derived from validated `azx plan
--json` output**, not hand-predicted.

---

## Two azx codegen bugs the harness documents (`src/bicep.ts`)

- **bug1 (compile):** `Microsoft.CognitiveServices/accounts` emits
  `customSubDomainName: name` — a bare, undeclared identifier → **BCP057**. Every
  chat-model app (`next-openai`) fails `az bicep build` until this is fixed.
- **bug2 (what-if):** `Microsoft.App/containerApps` emits an empty `containers: []`
  with cpu/mem `0`. It *compiles* fine but fails Azure's what-if preflight
  (`ContainerAppCreateMustContainContainer`). Every app has a `web` container app, so
  what-if fails for all of them — which is exactly why the harness keeps the compile
  and what-if gates **separate**.

Fixing either bug means changing `src/bicep.ts` and regenerating goldens
(`UPDATE_GOLDENS=1 npm test`), then flipping the corresponding gate(s) in
`expectations.json`. Offered as a follow-up, not done here.

---

## Run it locally

Build azx, then drive the whole pipeline with the cross-platform runner
`test/e2e/local.mjs`. It does plan → bicep → compile → (optional what-if) → assert
for one fixture or all of them, and prints a per-gate table plus a summary.

```bash
npm install --registry=https://registry.npmjs.org/
npm run build

# offline gates (analyzed + plan-match + compile) — no Azure needed
node test/e2e/local.mjs                       # all four fixtures
node test/e2e/local.mjs --app next-minimal    # just one
```

The runner exits non-zero only on a **hard fail** (plan-match drift, or a gate
flipping the *good* way). Known bugs reconcile to `KNOWN` and stay green.

### Run the what-if gate locally (reuses your `az login`)

You don't need OIDC or an app registration to exercise what-if locally — just be
logged in (`az login`) with a subscription you can create resource groups in. Add
`--whatif`:

```bash
node test/e2e/local.mjs --app next-minimal --whatif      # one app
node test/e2e/local.mjs --whatif                         # all apps
```

For each app that compiles, the runner:
1. creates an **ephemeral** resource group (`azx-e2e-local-<app>-<ts>`, tagged
   `azx-e2e=1 ttl=2h`, region from `expectations.json`),
2. runs `az deployment group what-if` — a **preflight only**, it deploys nothing,
3. deletes the RG afterward (pass `--keep` to leave it for inspection).

Flags: `--sub <id>` (default = current `az` context), `--region <r>` (default from
`expectations.json`), `--keep`. If you pass `--whatif` without being logged in, the
runner stops with a clear message rather than silently skipping.

With what-if on, `next-minimal` reports **what-if = KNOWN (bug2)** — Azure's
validator rejects the empty container app with the real errors:

```
ContainerAppCreateMustContainContainer - Must specify atleast one container ...
ContainerAppInvalidResourceTotal       - requested CPU and memory (CPU: 0, memory: 0) is invalid ...
```

That is bug2 observed live, not merely asserted. `next-openai` auto-**skips**
what-if because it never compiles (bug1).

To **tinker**: edit a fixture (add a dep, a route, an env var), re-run the runner,
and watch which gate moves. If you change what azx *should* produce, update
`expectations.json` to match.

> Scratch artifacts (plan/bicep/what-if output) land in `test/e2e/.local/`, which is
> gitignored.

---

## Run it in CI

`.github/workflows/e2e.yml` (`workflow_dispatch` + PRs touching `test/e2e/**`,
`src/**`, or the workflow) runs the matrix over all four fixtures and writes a gate
table to the job summary. It builds azx off the **public** npm registry
(`rm package-lock.json && npm install --registry=https://registry.npmjs.org/`) so it
is not blocked by the internal-feed lockfile.

### Optional: enable the what-if gate (BYO-Azure)

The what-if gate only runs if you point the harness at your own subscription via
GitHub OIDC (no client secret is stored). One-time setup:

```bash
scripts/setup-azure-oidc.sh --subscription <your-sub-id>      # bash
# or
scripts/setup-azure-oidc.ps1 -Subscription <your-sub-id>      # PowerShell
```

That creates a federated Entra app, grants it Contributor on the subscription, and
sets three repo **variables** (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`). The workflow then logs in via `azure/login@v2`, spins up an
ephemeral resource group per run, runs what-if, and deletes the RG afterward. Revoke
anytime with `az ad app delete --id <appId>`.

With creds present you'll see what-if report **fail (known: bug2)** for the three
container apps — proving the second, deeper gate works.
