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
| **what-if**    | `az deployment group what-if` against a dedicated validation RG passes preflight | **yes** (BYO-Azure) |

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
| `next-minimal`         | `next` dep + `next.config.mjs` | web-compute | app-env, web | ✅ pass | ✅ pass |
| `next-prisma-postgres` | `prisma/schema.prisma` (postgresql) | + transactional-relational | + postgres, postgres-db | ✅ pass | ✅ pass |
| `next-openai`          | `app/api/chat/route.ts` (gpt-4o) | + chat-model | + openai, openai-deploy-gpt-4o-62gtzg | ✅ pass | ✅ pass |
| `next-blob-storage`    | `lib/blob.ts` (`BlobServiceClient`) | + object-storage | + storage, blob | ✅ pass | ✅ pass |

`expectations.json` is the source of truth and was **derived from validated `azx plan
--json` output**, not hand-predicted.

---

## Gate status

The original Cognitive Services subdomain and empty Container Apps template bugs are
fixed. All fixtures compile and pass Azure what-if when optional OIDC variables are
configured. OpenAI model availability remains an external catalog dependency, so a
future regional retirement will fail the gate and require an explicit baseline decision.

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

With what-if on, every committed fixture is expected to pass. A failure is either a
code-generation regression or an Azure catalog/platform change; the harness fails
closed so the new result must be investigated rather than silently accepted.

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

That creates a main-branch-only federated Entra app and four persistent, empty
validation resource groups. The app receives Contributor only on those groups—not
the subscription—and the setup writes three repo **variables**
(`E2E_AZURE_CLIENT_ID`, `E2E_AZURE_TENANT_ID`, `E2E_AZURE_SUBSCRIPTION_ID`). These
are deliberately separate from the hosted SPA's `AZURE_CLIENT_ID`. Pull-request jobs
compile and plan offline but cannot obtain Azure credentials. Revoke anytime with
`az ad app delete --id <appId>`.

The scripts refuse to reuse an app by display name because Entra display names are
not unique. To harden or repair an existing setup, rerun with `--app-id <id>` (bash)
or `-AppId <id>` (PowerShell); the script then removes legacy federation and broad
Contributor assignments before verifying the resource-group scopes.

With the variables present, trusted `main` runs exercise the real ARM what-if gate.
