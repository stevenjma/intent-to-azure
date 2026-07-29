# App Intent — SPEC (v0.1)

> The open, capability-shaped contract behind `POST /v1/intent`.
> **Point at your repo. We figure out what the app needs. Azure runs it.**

This spec is intentionally small and open. Any tool can emit an **App Intent**
document; any planner can resolve one. `azx` is the reference implementation:
it *reads* a repo to produce the document, then *resolves* it to an Azure
resource graph — all offline in POC #1 (no real cloud calls).

The machine-readable schema is [`app-intent.schema.json`](./app-intent.schema.json)
(JSON Schema 2020-12). This document is the human companion.

---

## 1. Design principles

1. **Capability-shaped, not provider-shaped.** The request says *what the app
   needs* (`chat-model`, `transactional-relational`), never *which Azure SKU*.
   Provider resolution is a separate, swappable stage.
2. **Open & extendable.** `capability` and `options` are open. Adding a new
   capability **never breaks** existing consumers: unknown values are preserved
   (not dropped) and existing capabilities keep their safe defaults. Wiring one
   up end-to-end in the `azx` reference resolver is a separate matter — a
   deliberate multi-file change (see [§10](#10-how-to-add-a-capability)). The
   *contract* is extensible; the reference resolver is not automatic.
3. **Evidence-first.** Every conclusion carries the signals it came from, plus a
   confidence tier. Nothing is asserted without a trail.
4. **Confirm, don't guess.** Anything below `high` confidence surfaces as a
   confirm card rather than a silent (possibly wrong) decision.
5. **Guardrails win.** When repo signals and policy disagree, policy wins.

---

## 2. The pipeline (stages 0 → 3)

```
[0] read-repo      detect framework, db, AI usage, deploy conventions from real files
        │              (package.json / lockfiles, migrations, DATABASE_URL, imports/env, CI)
        ▼
[0.5] extract      group signals → capabilities, derive confidence, build the App Intent
        │
[1] auth+guardrails apply guardrails.yaml (region/model/spend); policy overrides repo
        │              (auth is stubbed in this POC)
        ▼
[2] plan           resolve capabilities → Azure services/region/SKU → summary + Bicep
        │
[3] run+watch      STUB: print what *would* deploy — never deploys in POC #1
```

`azx plan` runs stages 0 → 2. `azx up` adds the stage-3 stub.

---

## 3. Document shape

A minimal, hand-authored request needs only `version`, `app`, and `needs`:

```json
{
  "version": "0.1",
  "app": { "name": "contoso-marketing", "root": ".", "framework": "nextjs", "language": "typescript" },
  "needs": [
    { "capability": "web-compute", "confidence": "high", "rationale": "Next.js app", "evidence": ["package.json depends on \"next\""] },
    { "capability": "transactional-relational", "confidence": "high", "rationale": "Prisma + Postgres",
      "options": { "engine": "postgres" }, "evidence": ["prisma/schema.prisma", "DATABASE_URL in .env"] },
    { "capability": "chat-model", "confidence": "high", "rationale": "OpenAI SDK",
      "options": { "provider": "openai", "models": ["gpt-4o"] }, "evidence": ["depends on \"openai\"", "OPENAI_API_KEY"] },
    { "capability": "object-storage", "confidence": "medium", "rationale": "Blob SDK usage",
      "evidence": ["@azure/storage-blob import"] }
  ]
}
```

The engine enriches this with `signals`, `confirmations`, and `meta`. Those
fields are **produced by**, not **required of**, an emitter.

### Fields

| Field | Required | Notes |
|---|---|---|
| `version` | ✓ | `"0.1"` |
| `app` | ✓ | `name`, `root` required; `framework` / `language` / `runtime` optional |
| `needs[]` | ✓ | `capability` + `confidence` required; `options` / `rationale` / `evidence` optional |
| `guardrails` | — | policy; overrides repo signals |
| `budget` | — | subscription offer id / spend limit context |
| `signals[]` | engine | evidence trail (see confidence model) |
| `confirmations[]` | engine | medium/low items to confirm |
| `meta` | engine | `generatedBy`, `generatedAt`, `stages` |

---

## 4. Capability vocabulary (MVP corpus)

| Capability | Meaning | Key `options` |
|---|---|---|
| `web-compute` | HTTP app / API to run | — |
| `transactional-relational` | Relational OLTP database | `branching`, `consistency`, `pgvector`, `engine` |
| `chat-model` | LLM chat / completions | `provider`, `models` |
| `embeddings` | Embedding generation | `provider`, `models`, `servedBy` |
| `search-index` | Vector / keyword search index | — |
| `object-storage` | Blob/object storage | — |
| `background-jobs` | Scheduled / queued work | — |

The union is documentation, not a closed set. Emitters may introduce new
capabilities; planners that don't understand one should surface it as a confirm
card rather than fail.

---

## 5. Confidence model

| Tier | Rule | Behavior |
|---|---|---|
| `high` | 2+ **independent** signals (different `kind`) agree, **and at least one is non-weak** | applied silently |
| `medium` | a single non-weak signal — **or** 2+ weak signals of different kinds | emit a **confirm** card |
| `low` | a lone `weak` signal (or an absence) | **ask once** |

> **The `hasStrong` nuance:** a "strong" (non-`weak`) signal is required to reach
> `high`. Two *weak* signals of different kinds corroborate only up to `medium`,
> not `high` — weak hints never promote each other past a confirm card. This is
> exactly `deriveConfidence()` in `src/confidence.ts`.

Independence is by `SignalKind` (`dependency`, `import`, `env`, `migration`,
`config`, `framework-file`, `dockerfile`, `ci`, `manifest`). A dependency **and**
an env var pointing at the same capability corroborate; two dependencies do not.

The signals table (`signal → conclusion → confidence`) is printed by `azx scan`
and `azx plan`. Only `medium` / `low` items become confirmations.

---

## 6. Capability → Azure mapping (MVP defaults)

| Capability | Azure service | Notes / fallbacks |
|---|---|---|
| `web-compute` | Container Apps | fallback: App Service / Static Web Apps |
| `transactional-relational` | Postgres Flexible Server | `pgvector` → `vector` extension in-DB |
| `chat-model` | Azure OpenAI + deployment | model filtered by `approvedModels` |
| `embeddings` | Azure AI Search | unless `servedBy: pgvector` (stays in Postgres) |
| `search-index` | Azure AI Search | deduped with `embeddings` into one service |
| `object-storage` | Blob Storage (StorageV2) | container child resource |
| `background-jobs` | Container Apps Job | shares the managed environment |

SKUs bias to **economy** under a sponsorship / free-trial subscription or an
`economy` guardrail; otherwise **standard**. Region is guardrail-pinned when a
policy is present, else defaults to `eastus2` and raises a confirm card.

---

## 7. Guardrails & budget

`guardrails.yaml` (optional) constrains the plan and **wins** over repo signals:

```yaml
regions: [swedencentral]          # first entry is preferred; pins region (no confirm)
approvedModels: [gpt-4o, text-embedding-3-large]
budget:
  monthlyCapUsd: 150
  onExceed: block                  # or: warn
skuTier: economy                   # economy | standard
notes:
  - "EU data-residency: Europe regions only."
```

Budget context is mocked from `.azx/subscription.json` (no real Azure call):

```json
{ "subscriptionId": "00000000-0000-0000-0000-000000000000", "offerId": "MS-AZR-0036P", "spendingLimit": "on" }
```

A sponsorship offer (`MS-AZR-0036P`/`-0143P`) or free-trial (`-0044P`) biases to
economy SKUs and warns on burn.

---

## 8. Resolved plan (response)

Resolving an App Intent yields an `AzurePlan`: a `resources[]` graph (each with
`id`, `name`, `type`, `service`, `sku`, `region`, `dependsOn`, an
`estimatedMonthlyUsd`), a plain-English `summary`, carried-over `confirmations`,
`guardrailNotes`, `warnings`, and a `budget` roll-up. `generateBicep(plan)`
emits a deterministic `main.bicep` from that graph.

Full response = `{ intent, plan }` (see `IntentResponse`), plus `bicep` from the
CLI. **POC #1 is generate + preview only — `dryRun: true`, no Azure calls.**

---

## 9. Stability

`v0.1` is a preview. Required fields (`version`, `app`, `needs`) are stable;
engine-added fields may gain properties. Consumers should ignore unknown keys.

---

## 10. How to add a capability

Adding a capability to the **contract** is free (any string is a valid
`capability`; unknown ones surface as a confirm card and are never dropped).
Wiring one into the `azx` reference resolver end-to-end is a deliberate change
that currently touches ~6–8 files. Follow this checklist:

1. **`src/types.ts`** — add the name to the `KnownCapability` union
   (`~L18–25`). Add any capability-specific `options` interface.
2. **`src/azure-map.ts`** — add a `buildX()` builder that returns the
   `AzureResource[]` for the capability.
3. **`src/plan.ts`** — add a `case` to the `buildResources` switch
   (`~L116–149`) calling the new builder, and add the name to
   `RESOLVABLE_CAPABILITIES` so it stops surfacing as "unresolved".
4. **`src/bicep.ts`** — three places: the `API_VERSIONS` map (`~L11–23`),
   the SKU block (`~L132–152`), and the properties block (`~L160–289`).
5. **`src/extract-intent.ts`** — add a `CONFIRM_QUESTION` entry (`~L160–168`)
   and slot the name into `CAPABILITY_ORDER` (`~L32–40`) for stable output.
6. **Detection** — teach `src/read-repo.ts` to emit signals for the capability
   (so the read-repo path can actually detect it), and add a fixture + golden
   under `examples/` and `test/golden/`.

Miss a step and nothing *breaks* — the capability simply falls through to the
"unresolved capability" confirm card until the resolver is wired up.
