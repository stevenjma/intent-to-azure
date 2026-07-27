# vector-search-api (fixture)

A FastAPI service that computes embeddings with Azure OpenAI and stores/queries
them with **pgvector** in Postgres. It has a `Dockerfile`, a
`db/migrations/001_init.sql` that runs `CREATE EXTENSION vector`, and a
pay-as-you-go subscription fixture (standard SKUs).

This is a **sample repo for `azx`** — not a runnable service. It exercises the
confirmation path:

```
azx plan examples/vector-search-api
```

Expected: web-compute → Container Apps, transactional-relational → Postgres
Flexible Server with the `vector` extension. Because there are no guardrails,
`azx` asks you to confirm the **region** (defaults to eastus2) and, because
vectors are served by pgvector, offers **Azure AI Search** as an alternative
(medium confidence).
