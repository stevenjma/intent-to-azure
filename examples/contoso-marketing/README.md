# contoso-marketing (fixture)

A Next.js 14 marketing site with a Postgres database (Prisma), an OpenAI chat
route, and Azure Blob storage for assets. It ships a GitHub Actions workflow
that deploys to Azure Container Apps, plus a `guardrails.yaml` (Europe-only,
approved models, $200/mo cap, economy SKUs) and a sponsored-subscription
fixture in `.azx/subscription.json`.

This is a **sample repo for `azx`** — it is not a runnable app. It exists so
`azx plan examples/contoso-marketing` produces an all-high-confidence plan with
zero confirmations (guardrails pin the region and the model allow-list).

```
azx plan examples/contoso-marketing
```

Expected: web-compute → Container Apps, transactional-relational → Postgres
Flexible Server, chat-model → Azure OpenAI (gpt-4o), object-storage → Blob
Storage — all pinned to swedencentral on economy SKUs.
