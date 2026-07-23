CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
    id        BIGSERIAL PRIMARY KEY,
    content   TEXT NOT NULL,
    embedding vector(3072)
);

CREATE INDEX ON documents USING hnsw (embedding vector_cosine_ops);
