# azx — App Intent Service

> **Point at your repo. We figure out what the app needs. Azure runs it.**

`azx` reads an AI-native app repository the way a senior engineer skims a project —
`package.json`, lockfiles, migrations, `DATABASE_URL`, imports, GitHub Actions — infers
*what the app needs* as an open, **capability-shaped** contract, resolves that to a concrete
Azure resource graph, and generates Bicep. You never describe the app or write a config file.

**POC #1 is a dry-run engine.** It is 100% offline: it **never calls Azure or GitHub**. It
reads local files, prints a plan, and emits Bicep you can review. `plan` and `apply` are kept
strictly separate — this POC only ever *generates and previews*.

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

[3] run + watch      STUB ONLY. Prints "would deploy". Never touches Azure.
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
  up <path>      STUB: print what would deploy (stage 3 — never deploys)
  schema         print the open app-intent.schema.json contract
  help           show this help

FLAGS
  --json                 machine-readable output ({ intent, plan, bicep })
  --guardrails <file>    apply a guardrails.yaml (policy wins over repo)
  --subscription <file>  budget context (mock subscription.json)
  --out <file>           write Bicep/schema to a file
  --no-bicep             omit the Bicep block from 'plan' output
  --no-color             disable ANSI color
```

Everything is an offline dry-run. `azx` never calls Azure in POC #1.

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
src/            core engine (readRepo, extractIntent, plan, azure-map, bicep, run stub, cli)
examples/       3 runnable AI-native fixtures
test/           golden snapshots + schema-conformance tests
app-intent.schema.json   the open contract (JSON Schema 2020-12)
SPEC.md         human-readable contract spec
```

## Scope & guardrails (POC #1)

- Backend/engine first — **no web UI**.
- **No real Azure or GitHub API calls.** Generate + preview only.
- No invented SKUs/regions beyond the MVP mapping; uncertainty becomes a confirmation.
- Runs entirely offline with zero cloud credentials.

## License

MIT — see [`LICENSE`](./LICENSE).
