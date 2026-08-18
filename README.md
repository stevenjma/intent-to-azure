# azx — App Intent Service

> **Point at your repo. We figure out what the app needs. Azure runs it.**

`azx` reads an AI-native app repository the way a senior engineer skims a project —
`package.json`, lockfiles, migrations, `DATABASE_URL`, imports, GitHub Actions — infers
*what the app needs* as an open, **capability-shaped** contract, resolves that to a concrete
Azure resource graph, and generates Bicep. You never describe the app or write a config file.

**The default flow is a dry-run engine.** `plan`, `bicep`, `what-if`, and plain `up`
are 100% offline: they **never call Azure or GitHub** — they read local files, print a
plan, and emit Bicep you can review. Real deployment is **opt-in and explicit**: `up
--local-deploy` runs `az` on your machine, and `ship --create-repo` creates a GitHub
repo whose pipeline deploys via OIDC (see [Deploy for real](#deploy-for-real-two-phases)). `plan`
and `apply` are always kept separate — nothing deploys unless you ask for it.

```
┌──────────┐   reads code    ┌───────────────┐   resolves      ┌──────────────┐
│  your    │  ─────────────▶ │  App Intent   │  ─────────────▶ │  Azure plan  │
│  repo    │   (signals)     │  (contract)   │  (capability→   │  + Bicep     │
└──────────┘                 └───────────────┘    Azure map)   └──────────────┘
                                                                 dry-run · no cloud calls
```

---

## 30-second quickstart

No cloud credentials required.

```bash
npm install
npm run build

# Resolve a bundled Next.js + Postgres + OpenAI + Blob app:
node dist/src/cli.js plan examples/contoso-marketing

# ...or link the binary and use `azx` directly:
npm link
azx plan examples/vector-search-api
azx plan examples/django-notes --json
```

`azx plan <path>` runs pipeline stages **0 → 2** and prints: the extracted **signals table**,
the **App Intent JSON**, the resolved **Azure plan** (plain-English + Bicep), and any
**confirmation cards** for low-confidence guesses.

---

## Run it on your own repo

The bundled `examples/` are just a fast first look — `azx` is built to read **your**
project. Point it at any local repo and it runs the same offline stages 0 → 2.

**Prerequisites:** Node **20+** and npm. No cloud credentials; no Azure or GitHub calls.

```bash
npm install && npm run build
npm link                     # puts `azx` on your PATH (once)

# Point it at your app — absolute or relative paths both work:
azx plan /path/to/your/app
# ...or without linking:
node dist/src/cli.js plan ../my-service
```

**What comes back** (printed to your terminal; nothing is written unless you ask):

- a **signals table** — every detected signal → conclusion → confidence
- the **App Intent JSON** — the open, capability-shaped contract
- the resolved **Azure plan** — plain-English resources plus `main.bicep`
- any **confirmation cards** for guesses `azx` will not make silently

(See the Confidence model, contract, and Capability → Azure mapping sections below for how each is derived.)

**Bring your own policy.** Drop either file in your repo and `azx` picks it up automatically
during the scan:

- `guardrails.yaml` (repo root) — region allow-list, approved models, spend cap, SKU tier.
  Guardrails **win** over anything detected in the code.
- `.azx/subscription.json` — mock Offer ID + spending limit; a `sponsorship` classification
  defaults to economy SKUs and warns on burn.

```bash
# Override or point at policy files elsewhere:
azx plan /path/to/your/app --guardrails guardrails.yaml --subscription .azx/subscription.json
azx plan /path/to/your/app --json          # machine-readable { intent, plan, bicep }
```

**When `azx` isn't sure.** Stacks outside the MVP corpus (Next.js / FastAPI / Django ·
Postgres / pgvector · OpenAI / Anthropic / Azure OpenAI · GitHub Actions) never produce a
wrong guess — they surface as a **confirmation card** you resolve, or you supply an
escape-hatch declarative file. Uncertain SKUs and regions are never invented.

> **Preview by default.** `plan`, `bicep`, `what-if`, and plain `up` never call Azure —
> `azx` reads files, prints a plan, and emits Bicep for you to review. Deploying is a
> separate, explicit opt-in (`up --local-deploy`, `ship --create-repo`).

---

## The pipeline (stages 0 → 3)

```
[0] read-repo        detect framework, database, AI usage, storage, and deploy
                     conventions from real files (package.json / lockfiles /
                     migrations / DATABASE_URL / imports / GitHub Actions).

[1] auth + guardrails apply guardrails.yaml (region allow-list, approved models,
                     spend cap, SKU tier). Guardrails WIN when repo and policy
                     disagree. (Auth is stubbed in this POC.)

[2] plan             resolve capabilities → concrete Azure services / region / SKU.
                     Emit a plain-English summary + main.bicep. ← core deliverable

[3] run + watch      `azx up` prints "would deploy" (dry-run stub). Add
                     --local-deploy to REALLY deploy via `az` (what-if gated).

[3'] ship            scaffold a deploy repo (Bicep + CI/CD pipeline) and, with
                     --create-repo, create + push it via `gh`. The committed
                     GitHub Actions workflow runs the REAL Azure deploy via OIDC
                     (what-if gate → `az deployment group create`). azx still
                     makes no Azure calls itself — the pipeline does.
```

---

## The open contract — `POST /v1/intent`

The request is **capability-shaped, not provider-shaped**: it says *what the app needs*, not
which Azure product to use. The response is the resolved Azure resource graph. This openness is
deliberate — anyone can emit the format; `azx` is one implementation.

- Schema: [`app-intent.schema.json`](./app-intent.schema.json) (JSON Schema draft 2020-12)
- Human spec: [`SPEC.md`](./SPEC.md)

Capability vocabulary (extendable — a new capability never breaks existing ones,
though wiring one into `azx` end-to-end is a deliberate multi-file change; see
[SPEC §10](./SPEC.md#10-how-to-add-a-capability)):

`web-compute` · `transactional-relational` (with `branching`, `consistency`) · `chat-model` ·
`embeddings` · `search-index` · `object-storage` · `background-jobs`

```jsonc
{
  "version": "0.1",
  "app": { "name": "contoso-marketing", "runtime": "node", "framework": "nextjs" },
  "needs": [
    { "capability": "web-compute", "confidence": "high", "evidence": [ /* ... */ ] },
    { "capability": "transactional-relational", "confidence": "high" },
    { "capability": "chat-model", "options": { "provider": "openai", "models": ["gpt-4o"] } },
    { "capability": "object-storage", "options": { "provider": "azure-blob" } }
  ],
  "guardrails": { "regions": ["swedencentral", "westeurope"], "skuTier": "economy" }
}
```

---

## Capability → Azure mapping (MVP defaults)

| Capability                  | Azure service (default)                 | Fallbacks considered            |
| --------------------------- | --------------------------------------- | ------------------------------- |
| `web-compute`               | Container Apps                          | App Service · Static Web Apps   |
| `transactional-relational`  | PostgreSQL Flexible Server              | —                               |
| `chat-model`                | Azure OpenAI                            | —                               |
| `embeddings` / `search-index` | Azure AI Search                       | **pgvector stays in Postgres** (raised as a confirm card) |
| `object-storage`            | Blob Storage                            | —                               |
| `background-jobs`           | Container Apps Job                      | —                               |

Anything outside the MVP corpus surfaces as a **confirmation card** or an escape-hatch
declarative file — never a silent wrong guess. SKUs and regions beyond this mapping are never
invented; uncertainty becomes a confirmation.

---

## Confidence model

Every conclusion carries a confidence derived from independent signals:

| Confidence | Rule                                    | Behavior                          |
| ---------- | --------------------------------------- | --------------------------------- |
| `high`     | 2+ independent signals agree, ≥1 non-weak | applied silently                |
| `medium`   | 1 non-weak signal, or 2+ weak of different kinds | emit a **confirm** card    |
| `low`      | a lone weak / ambiguous hint            | ask once                          |

Only `medium`/`low` items surface as confirmations. A *strong* (non-`weak`)
signal is required to reach `high`: two weak hints corroborate only up to
`medium` (see `deriveConfidence()` in `src/confidence.ts`). The full
**signal → conclusion → confidence** table is always printed so the inference is
auditable.

---

## Sample output

`azx plan examples/contoso-marketing` (trimmed):

```
Signals
  KIND            SIGNAL                                          CONCLUSION                               CONF
  dependency      package.json depends on "openai"                chat-model (OpenAI SDK)                  high
  env             .env.example sets OPENAI_API_KEY                chat-model (OpenAI env)                  high
  dependency      package.json depends on "@prisma/client"        transactional-relational (Prisma ORM)   high
  ci              .github/workflows/deploy.yml deploys to Azure   web-compute (Azure deploy target in CI)  high
  ... (16 signals total, all high)

Azure Plan
  contoso-marketing: resolved 8 Azure resource(s) across 7 capability slot(s) in swedencentral (dry-run).
    • Azure Container Apps as "ca-contoso-marketing" ~$15/mo
    • Azure Database for PostgreSQL Flexible Server [Standard_B1ms] as "psql-contoso-marketing" ~$15/mo
    • Azure OpenAI [S0] as "oai-contoso-marketing"  +  deployment "gpt-4o"
    • Azure Blob Storage [Standard_LRS] as "stcontosomarketing" ~$5/mo
  Estimated total: ~$35/mo USD (cap $200/mo).
  Sponsorship subscription detected — defaulting to economy SKUs and warning on burn.

  Guardrails applied:
    • Region pinned to swedencentral by guardrails (allowed: swedencentral, westeurope).
    • Model allow-list enforced: gpt-4o, gpt-4o-mini, text-embedding-3-large.

  ⚠ sponsorship subscription: using economy SKUs; monitor burn against your credit.

main.bicep
  // main.bicep — generated by azx · DRY-RUN PREVIEW ONLY — azx made no Azure calls.
  resource web 'Microsoft.App/containerApps@2024-03-01' = { ... }
  resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = { ... }
  ...
```

The **pgvector** fixture (`examples/vector-search-api`) shows the confirm path: it detects
`transactional-relational` with `pgvector: true`, keeps vectors in Postgres, and raises a
confirmation asking whether you'd rather use Azure AI Search — instead of guessing.

---

## CLI

```
azx <command> [path] [flags]

COMMANDS
  plan <path>    read repo → extract intent → resolve Azure plan + Bicep (stages 0→2)
  scan <path>    detect the app and print the signals table (stage 0)
  bicep <path>   print just the generated main.bicep
  what-if <path> offline plan diff vs a prior plan (--against) + approval gate
  up <path>      dry-run stub by default; add --local-deploy to REALLY deploy via `az`
  ship <path>    scaffold a deploy repo (Bicep + CI/CD) and, with --create-repo,
                 create + push it so its pipeline runs the REAL Azure deploy (OIDC)
  schema         print the open app-intent.schema.json contract
  help           show this help

FLAGS
  --json                 machine-readable output ({ intent, plan, bicep })
  --guardrails <file>    apply a guardrails.yaml (policy wins over repo)
  --subscription <file>  budget context (mock subscription.json)
  --out <file|dir>       write Bicep/schema to a file, or the ship scaffold to a dir
  --scaffold <dir>       plan: also write the full deploy repo tree (Bicep + CI/CD)
  --create-repo <o/n>    ship: create + push a real GitHub repo (owner/name)
  --deploy               ship: trigger the deploy pipeline after push (real deploy)
  --private/--no-private ship: repo visibility (default: private)
  --local-deploy         up: REALLY deploy to Azure via `az` (needs `az login`)
  --yes                  up --local-deploy: apply for real (else what-if only)
  --resource-group <rg>  up --local-deploy: target RG (default rg-<app>)
  --region <r>           up --local-deploy: target region (default: plan region)
  --pg-password <p>      up --local-deploy: PostgreSQL admin password (if provisioned)
  --subscription-id <id> up --local-deploy: pin the Azure subscription
  --no-bicep             omit the Bicep block from 'plan' output
  --no-color             disable ANSI color
```

`plan --scaffold` and plain `up` are fully offline. `up --local-deploy` and
`ship --create-repo` are the only paths that leave the machine: `up --local-deploy`
calls `az` directly, while `ship` only runs git + `gh` (the real `az deployment group
create` runs inside the pushed GitHub Actions pipeline via OIDC — azx never calls it).

---

## Deploy for real: two phases

`azx` reaches real Azure two ways — a fast imperative **inner loop**, then a
codified **outer loop** — and they compose: both apply the *same* `main.bicep`, so
promoting from one to the other is provably safe.

### Phase 1 — local deploy (imperative, fast)

`azx up --local-deploy` really creates the resources via the Azure CLI. What-if is
always previewed first; the apply only happens with `--yes`:

```bash
az login                                   # once
azx up /path/to/app --local-deploy         # what-if only (a safe preview)
azx up /path/to/app --local-deploy --yes   # apply for real
#   --resource-group <rg>   target RG (default rg-<app>)
#   --region <r>            target region (default: plan region)
#   --pg-password <p>       PostgreSQL admin password (if the plan provisions it)
#   --subscription-id <id>  pin the subscription
```

On a real apply it writes **`.azx/deploy.json`** — the *continuity ledger* (RG,
region, deployment name, resource names). `az` group-scoped what-if needs the RG to
exist, so even a preview ensures an (empty) resource group.

### Phase 2 — codify / harden (declarative, durable)

`azx ship` promotes that deployment into a reviewed GitHub repo + OIDC pipeline. If a
ledger is present it **adopts** it — pinning the same RG/region so the pipeline's
first `what-if` typically reports **no changes**, taking ownership of the resources
local deploy already made rather than duplicating them. The ledger records the
deployed template's hash, so `ship` warns if the plan has drifted since (in which case
the first what-if won't be a no-op — review it before approving).

## Ship it: from plan to a real Azure deploy

`plan --scaffold` and `ship` promote the offline plan into a **real, deployable
GitHub repo** whose CI/CD pipeline runs the actual Azure deploy. Two modes, one
engine:

**1. Generate the whole repo, inert (`plan --scaffold <dir>`)** — writes the full
tree to disk but wires up nothing live:

```bash
azx plan /path/to/app --scaffold ./out
# out/
#   infra/main.bicep                 the generated template
#   .github/workflows/deploy.yml     the CI/CD pipeline (what-if gate → real deploy)
#   README.md                        plan summary + setup steps
#   .azx/plan.json                   the resolved intent + plan
#   .gitignore
```

**2. Make it breathe (`ship`)** — turn that scaffold into a live repo:

```bash
# dry-run: print the scaffold + the exact git/gh commands it WOULD run
azx ship /path/to/app

# for real: create + push a private GitHub repo (needs `gh auth login`)
azx ship /path/to/app --create-repo my-org/my-app

# ...and trigger the pipeline so the deploy runs immediately
azx ship /path/to/app --create-repo my-org/my-app --deploy
```

**How the real deploy happens.** The pushed `deploy.yml` authenticates to Azure via
**GitHub OIDC** (no stored secret) and runs two jobs: `what-if` (an
`az deployment group what-if` safety gate) then `deploy` — gated behind a
`production` environment you can require reviewers on — which runs the real
`az deployment group create`. Provision the federated identity + the three repo
variables once with:

```bash
./scripts/setup-azure-oidc.sh      # bash; on Windows use WSL, Git Bash, or Azure Cloud Shell
```

> Even in `ship` mode, **azx itself never calls Azure**. It only writes files and
> (with `--create-repo`) runs `git`/`gh`. The Azure deploy is owned entirely by the
> pipeline in the repo it creates — plan and apply stay strictly separate.

---

## End-to-end walkthrough (real deploy)

A complete run, from a cold repo to live Azure resources owned by a CI/CD pipeline.
The two phases are independent — you can stop after Phase 1, or skip straight to
Phase 2 — but done in order they chain into one story.

**Prerequisites**

- Node **20+**, and the repo built once: `npm install && npm run build`
  (link it with `npm link` so `azx` is on your PATH, or use `node dist/src/cli.js`).
- **Azure CLI** logged in: `az login` (Phase 1) and permission to create resources.
- **GitHub CLI** logged in: `gh auth login` (Phase 2).

**0. Preview offline (no cloud, no credentials)**

```bash
azx plan /path/to/app                 # signals → intent → Azure plan + Bicep
azx plan /path/to/app --scaffold ./out   # also writes the full deploy repo tree
```

**1. Local deploy — get it running now (imperative)**

```bash
az login
azx up /path/to/app --local-deploy                 # what-if only: a safe preview
azx up /path/to/app --local-deploy --yes \
  --pg-password 'Str0ng!Pass'                       # apply for real (password only if Postgres)
```

What happens: `az account show` (auth gate) → `az group create` → `az deployment
group what-if` (gate) → `az deployment group create`. On success it writes
`/path/to/app/.azx/deploy.json` — the continuity ledger. Your Azure **infrastructure**
is now live in `rg-<app>` — but the Container App runs Microsoft's placeholder
quickstart image (`mcr.microsoft.com/k8se/quickstart`), not your code, until you build
and push your own container image to the app. This provisions the platform; shipping
your app image is the next step.

**2. Codify / harden — hand the deploy to a reviewed pipeline (declarative)**

```bash
azx ship /path/to/app --create-repo my-org/my-app   # create + push the deploy repo
```

Because `ship` reads `.azx/deploy.json`, the generated repo pins the **same** RG and
region and records the deployed template's hash (it warns if the plan has drifted).
The scaffold it pushes includes `scripts/setup-azure-oidc.sh` — the OIDC bootstrap
for *this* repo.

**3. Wire up OIDC + secrets in the generated repo (one time)**

```bash
git clone https://github.com/my-org/my-app && cd my-app
gh auth login
./scripts/setup-azure-oidc.sh    # federates THIS repo's main + production; sets AZURE_* vars
```

This federates the two subjects the pipeline authenticates as
(`ref:refs/heads/main` and `environment:production`), **pre-creates the resource group
and grants the app Contributor scoped to that resource group only** (not the whole
subscription), and sets the repo **variables** `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` /
`AZURE_SUBSCRIPTION_ID` (no secret stored). Then, in the generated repo:

- add a repo **secret** `PG_ADMIN_PASSWORD` if your app provisions Postgres (it must
  match the `--pg-password` you used in Phase 1, or the first what-if won't be a no-op),
- (recommended) in **Settings → Environments**, add required reviewers to
  `production` so the real deploy waits on approval, and
- (recommended) protect `main`. The what-if job needs deploy-equivalent rights, so
  branch protection is the compensating control that keeps the `main` credential from
  acting inside the resource group without review.

**4. Deploy through the pipeline & verify the clean handoff**

```bash
gh workflow run deploy.yml --repo my-org/my-app   # or just push to main
```

The pipeline's first `what-if` job should report **no changes** — it adopted the
resources Phase 1 created rather than duplicating them. From then on, every push to
`main` deploys through review + OIDC; no local credentials, no ad-hoc `az`.

> **Cleanup:** local deploy (and even a what-if preview) creates a resource group.
> Remove everything with `az group delete -n rg-<app> --yes --no-wait`.

---

## Library API

The CLI is a thin shell over pure, importable functions — the same seam a future MCP server
(POC #2) wraps as tools. Nothing here touches the network on the default path.

```ts
import {
  readRepo,        // stage [0]   → RepoScan                    (MCP: scan_repo)
  extractIntent,   // stage [0.5] → AppIntent                   (MCP: extract_intent)
  plan,            // stage [2]   → AzurePlan                    (MCP: plan)
  generateBicep,   // stage [2]   → string (main.bicep)         (MCP: generate_bicep)
  dryRun,          // stage [3]   → RunResult (stub, never deploys)
  runLocalDeploy,  // stage [3]   → LocalDeployResult (imperative `az` deploy + ledger)
  buildScaffold,   // stage [3a]  → ScaffoldFile[] (Bicep + CI/CD repo tree)
  shipSteps,       // stage [3b]  → ShipPlan (the git/gh commands, pure)
  runShip,         // stage [3b]  → ShipResult (writes + runs — the only side-effect)
  resolveRepo,     // convenience: the whole 0→2 pipeline in one call
} from "azx";

const { intent, plan: azurePlan, bicep } = resolveRepo("examples/contoso-marketing");
```

`resolveRepo(root, opts)` reads the repo, loads `guardrails.yaml` and `.azx/subscription.json`
when present (both offline), and returns the full `POST /v1/intent` response shape plus Bicep.

---

## Guardrails & budget

- **`guardrails.yaml`** (repo root) — region allow-list, approved models, monthly spend cap, and
  SKU tier. Policy **wins** over anything detected in the repo. See
  `examples/contoso-marketing/guardrails.yaml`.
- **`.azx/subscription.json`** — mock subscription/offer context (Offer ID + spending limit). A
  startup-**sponsorship** classification defaults to cheaper SKUs and warns on burn. See
  `examples/contoso-marketing/.azx/subscription.json`.

---

## Examples (fixtures)

| Fixture                      | Stack                                             | Demonstrates                          |
| ---------------------------- | ------------------------------------------------- | ------------------------------------- |
| `examples/contoso-marketing` | Next.js 14 · Prisma/Postgres · OpenAI · Blob · CI | full high-confidence path + guardrails + sponsorship budget |
| `examples/vector-search-api` | FastAPI · pgvector · Azure OpenAI embeddings      | pgvector → Postgres confirm card, no AI Search |
| `examples/django-notes`      | Django · Postgres (no AI)                         | non-AI baseline, region-only confirmation |

---

## Testing

```bash
npm test          # build + golden snapshots + schema-conformance + invariants
```

Golden snapshots of the App Intent JSON + Bicep for each fixture live in `test/golden/`. The
clock is pinned so output is deterministic. Regenerate goldens after an intended change:

```bash
# PowerShell
$env:UPDATE_GOLDENS=1; npm test; Remove-Item Env:\UPDATE_GOLDENS
# bash
UPDATE_GOLDENS=1 npm test
```

Every emitted intent is also validated against `app-intent.schema.json`.

---

## Roadmap — POC #2 (MCP surface)

POC #1 is engine-first by design. The next POC wraps this same library in a **Model Context
Protocol** server so agents (CLI, Copilot, Portal) can call it as tools — no logic is
re-implemented:

| MCP tool          | Library function  |
| ----------------- | ----------------- |
| `scan_repo`       | `readRepo`        |
| `extract_intent`  | `extractIntent`   |
| `plan`            | `plan`            |
| `generate_bicep`  | `generateBicep`   |

The north star: autonomous agents doing the deploy, reachable from many surfaces, all speaking
the one open App Intent contract.

---

## Project layout

```
src/            core engine (readRepo, extractIntent, plan, azure-map, bicep, scaffold, ship, cli)
examples/       3 runnable AI-native fixtures
test/           golden snapshots + schema-conformance tests
app-intent.schema.json   the open contract (JSON Schema 2020-12)
SPEC.md         human-readable contract spec
```

## Compatibility & known limitations

The hosted browser app ([`web/`](./web/README.md)) is a **proof of concept**. Who can
use it today depends entirely on one setting your Azure tenant admin controls — the
**user-consent policy** — not on your license tier:

| Your Azure account | Browser sign-in | Real deploy from the browser |
|---|---|---|
| Personal Microsoft account | ✅ works | ✅ works |
| Work/school tenant that allows user consent | ✅ works | ✅ works |
| Work/school tenant restricted to *verified-publisher* apps | ✅ works | ⚠️ deploy needs a one-time **admin consent** |
| Locked-down tenant (no user consent) | ⚠️ needs admin consent | ⚠️ needs admin consent |

**Why:** real deploy requests the Azure Resource Manager `user_impersonation` scope,
which is high-privilege and **requires tenant admin consent in every enterprise tenant**
— Publisher Verification does not waive it. The app detects this and surfaces a
one-click **admin-consent link** (an admin approves once per org). See
[web/README](./web/README.md#deployment-model-hosted-multi-tenant).

**Escape hatches that always work, regardless of tenant policy:**

- **The CLI** (below) — runs fully offline; `up --local-deploy` deploys through your own
  `az` login with no third-party app consent.
- **The codified pipeline** — `ship --create-repo` (or the browser's "codify" path)
  creates a repo whose GitHub Actions **OIDC** pipeline deploys under a per-tenant
  service principal your admin sets up once. No interactive ARM consent needed.

For a PoC launch, the practical audience is personal accounts and permissive
startup-style tenants; enterprise users are steered to the pipeline path.

## Scope & guardrails

- Backend/engine first; the browser app in [`web/`](./web/README.md) is a thin UI over
  the same engine (see the compatibility caveat above).
- The default commands (`scan`/`plan`/`bicep`/`what-if`/`up`) generate and preview
  offline. Two opt-in paths reach the network/cloud: `up --local-deploy --yes` runs
  the real Azure deploy locally through your `az` CLI, and `ship --create-repo` uses
  git + `gh` to create the repo whose OIDC pipeline then deploys. Everything else runs
  fully offline with zero cloud credentials.
- No invented SKUs/regions beyond the MVP mapping; uncertainty becomes a confirmation.

## License

MIT — see [`LICENSE`](./LICENSE).
