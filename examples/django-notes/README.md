# django-notes (fixture)

A plain Django app with a Postgres database (psycopg2 + `DATABASE_URL`) and a
`0001_initial` migration. No AI, no object storage, no guardrails — the
**non-AI baseline** in the corpus.

This is a **sample repo for `azx`** — not a runnable app.

```
azx plan examples/django-notes
```

Expected: web-compute → Container Apps, transactional-relational → Postgres
Flexible Server. With no guardrails, `azx` asks you to confirm the **region**
(defaults to eastus2). Nothing else is inferred — `azx` never guesses AI
services that aren't in the code.
