"""Semantic search API backed by pgvector + Azure OpenAI embeddings."""

import os

import asyncpg
from fastapi import FastAPI
from openai import AzureOpenAI

app = FastAPI(title="vector-search-api")

client = AzureOpenAI(
    azure_endpoint=os.environ["AZURE_OPENAI_ENDPOINT"],
    api_key=os.environ.get("AZURE_OPENAI_API_KEY"),
    api_version="2024-06-01",
)


@app.post("/search")
async def search(q: str):
    result = client.embeddings.create(model="text-embedding-3-large", input=q)
    embedding = result.data[0].embedding
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        rows = await conn.fetch(
            "SELECT id, content FROM documents ORDER BY embedding <-> $1 LIMIT 5",
            embedding,
        )
    finally:
        await conn.close()
    return [dict(r) for r in rows]
