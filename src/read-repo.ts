/**
 * Stage [0] read-repo — detect what an app needs by reading real files.
 *
 * Pure and offline: this only reads the local filesystem. No network. We skim
 * the repo the way a senior engineer would — manifests, lockfiles, migrations,
 * env files, source imports, Dockerfiles and CI workflows — and emit a flat
 * list of {@link Signal}s tagged with an independence `kind`.
 */

import { readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { AppInfo, Signal, SignalKind } from "./types.js";

export interface RepoScan {
  app: AppInfo;
  signals: Signal[];
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "coverage",
  ".azx",
]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".sql", ".yml", ".yaml", ".toml", ".json", ".cfg", ".ini", ".txt", ".md",
]);

const MAX_FILES = 4000;
const MAX_BYTES = 256 * 1024;

/** A cached, filtered view of the repository's text files. */
class RepoIndex {
  readonly root: string;
  readonly files: string[]; // repo-relative, forward-slashed, sorted
  private cache = new Map<string, string | undefined>();

  constructor(root: string) {
    this.root = root;
    const acc: string[] = [];
    walk(root, root, acc);
    this.files = acc
      .map((p) => p.split(sep).join("/"))
      .sort((a, b) => a.localeCompare(b));
  }

  has(rel: string): boolean {
    return this.files.includes(rel);
  }

  /** First existing path among candidates. */
  first(...candidates: string[]): string | undefined {
    return candidates.find((c) => this.has(c));
  }

  /** Read a repo-relative file, capped and cached. Returns undefined if absent. */
  read(rel: string): string | undefined {
    if (this.cache.has(rel)) return this.cache.get(rel);
    let text: string | undefined;
    try {
      const abs = join(this.root, rel);
      const st = statSync(abs);
      if (st.isFile() && st.size <= MAX_BYTES) text = readFileSync(abs, "utf8");
    } catch {
      text = undefined;
    }
    this.cache.set(rel, text);
    return text;
  }

  /** Repo-relative paths whose basename or path matches a predicate. */
  match(pred: (rel: string) => boolean): string[] {
    return this.files.filter(pred);
  }
}

function walk(root: string, dir: string, acc: string[]): void {
  if (acc.length >= MAX_FILES) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (acc.length >= MAX_FILES) return;
    const abs = join(dir, name);
    let st;
    try {
      // lstatSync (not statSync) so we can detect symlinks without following them.
      st = lstatSync(abs);
    } catch {
      continue;
    }
    // Do not follow symlinks: a symlinked dir/file could point outside the repo.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(name)) continue;
      walk(root, abs, acc);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
      const isEnv = name === ".env" || name.startsWith(".env");
      const isDockerfile = name === "Dockerfile" || name.startsWith("Dockerfile");
      if (TEXT_EXT.has(ext) || isEnv || isDockerfile || name === "Pipfile") {
        acc.push(relative(root, abs));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// readRepo
// ---------------------------------------------------------------------------

/** Read a repository and return the app info + raw signals (stage 0). */
export function readRepo(root: string): RepoScan {
  const idx = new RepoIndex(root);
  const signals: Signal[] = [];
  const push = (s: Signal) => signals.push(s);

  // Serialize a portable, machine-independent root (directory basename only) so
  // committed output/goldens never bake in an absolute path (e.g. C:\Users\...).
  // Filesystem access uses the local `root` var (and RepoIndex.root), not app.root.
  const app: AppInfo = { name: basename(root) || "app", root: basename(root) || "app" };

  detectNode(idx, app, push);
  detectPython(idx, app, push);
  detectEnv(idx, push);
  detectMigrations(idx, push);
  detectSourceImports(idx, push);
  detectContainer(idx, app, push);
  detectCi(idx, push);
  detectDeployConventions(idx, push);

  // Deterministic ordering: capability, then kind, then signal text.
  signals.sort(
    (a, b) =>
      String(a.capability ?? "~").localeCompare(String(b.capability ?? "~")) ||
      a.kind.localeCompare(b.kind) ||
      a.signal.localeCompare(b.signal),
  );

  // De-duplicate identical (kind, signal, conclusion) rows.
  const seen = new Set<string>();
  const deduped = signals.filter((s) => {
    const key = `${s.kind}|${s.signal}|${s.conclusion}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { app, signals: deduped };
}

// ---------------------------------------------------------------------------
// Node / JavaScript ecosystem
// ---------------------------------------------------------------------------

interface DepRule {
  cap: Signal["capability"];
  conclusion: string;
  framework?: string;
  provider?: string;
  weak?: boolean;
  option?: string;
}

const NODE_DEPS: Record<string, DepRule> = {
  next: { cap: "web-compute", conclusion: "web-compute (Next.js)", framework: "nextjs" },
  "@remix-run/node": { cap: "web-compute", conclusion: "web-compute (Remix)", framework: "remix" },
  nuxt: { cap: "web-compute", conclusion: "web-compute (Nuxt)", framework: "nuxt" },
  astro: { cap: "web-compute", conclusion: "web-compute (Astro)", framework: "astro" },
  express: { cap: "web-compute", conclusion: "web-compute (Express service)", framework: "express" },
  fastify: { cap: "web-compute", conclusion: "web-compute (Fastify service)", framework: "fastify" },
  "@nestjs/core": { cap: "web-compute", conclusion: "web-compute (NestJS service)", framework: "nestjs" },
  koa: { cap: "web-compute", conclusion: "web-compute (Koa service)", framework: "koa" },
  react: { cap: "web-compute", conclusion: "web-compute (React SPA)", framework: "react", weak: true },
  vite: { cap: "web-compute", conclusion: "web-compute (Vite app)", framework: "vite", weak: true },

  "@prisma/client": { cap: "transactional-relational", conclusion: "transactional-relational (Prisma ORM)" },
  prisma: { cap: "transactional-relational", conclusion: "transactional-relational (Prisma ORM)" },
  pg: { cap: "transactional-relational", conclusion: "transactional-relational (node-postgres)" },
  postgres: { cap: "transactional-relational", conclusion: "transactional-relational (postgres.js)" },
  "drizzle-orm": { cap: "transactional-relational", conclusion: "transactional-relational (Drizzle ORM)" },
  sequelize: { cap: "transactional-relational", conclusion: "transactional-relational (Sequelize)" },
  typeorm: { cap: "transactional-relational", conclusion: "transactional-relational (TypeORM)" },
  knex: { cap: "transactional-relational", conclusion: "transactional-relational (Knex)" },
  kysely: { cap: "transactional-relational", conclusion: "transactional-relational (Kysely)" },
  pgvector: { cap: "transactional-relational", conclusion: "transactional-relational + pgvector (in-DB vectors)", option: "pgvector" },

  openai: { cap: "chat-model", conclusion: "chat-model (OpenAI SDK)", provider: "openai" },
  "@anthropic-ai/sdk": { cap: "chat-model", conclusion: "chat-model (Anthropic SDK)", provider: "anthropic" },
  "@azure/openai": { cap: "chat-model", conclusion: "chat-model (Azure OpenAI SDK)", provider: "azure-openai" },
  "@azure-rest/ai-inference": { cap: "chat-model", conclusion: "chat-model (Azure AI Inference)", provider: "azure-openai" },
  ai: { cap: "chat-model", conclusion: "chat-model (Vercel AI SDK)", provider: "openai", weak: true },
  langchain: { cap: "chat-model", conclusion: "chat-model (LangChain)", provider: "openai", weak: true },

  "@azure/search-documents": { cap: "search-index", conclusion: "search-index (Azure AI Search SDK)" },
  algoliasearch: { cap: "search-index", conclusion: "search-index (Algolia)" },
  "@elastic/elasticsearch": { cap: "search-index", conclusion: "search-index (Elasticsearch)" },

  "@azure/storage-blob": { cap: "object-storage", conclusion: "object-storage (Azure Blob SDK)", provider: "azure-blob" },
  "@aws-sdk/client-s3": { cap: "object-storage", conclusion: "object-storage (AWS S3 SDK)", provider: "s3" },

  bullmq: { cap: "background-jobs", conclusion: "background-jobs (BullMQ)" },
  bull: { cap: "background-jobs", conclusion: "background-jobs (Bull)" },
  "graphile-worker": { cap: "background-jobs", conclusion: "background-jobs (graphile-worker)" },
};

function detectNode(idx: RepoIndex, app: AppInfo, push: (s: Signal) => void): void {
  const pkgPath = idx.first("package.json");
  if (!pkgPath) return;
  const raw = idx.read(pkgPath);
  if (!raw) return;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  app.runtime ??= "node";
  if (typeof pkg.name === "string" && pkg.name.trim()) app.name = pkg.name.trim();

  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };

  // Lockfile → runtime manifest signal (independent evidence for web-compute).
  const lock = idx.first("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb");
  if (lock) {
    push({
      kind: "manifest",
      signal: `lockfile ${lock}`,
      conclusion: "Node runtime (deployable web-compute)",
      capability: "web-compute",
      from: lock,
      weak: true,
    });
  }

  for (const [name, rule] of Object.entries(NODE_DEPS)) {
    if (!(name in deps)) continue;
    const detail: Record<string, unknown> = {};
    if (rule.framework) {
      detail.framework = rule.framework;
      if (!rule.weak) app.framework ??= rule.framework;
    }
    if (rule.provider) detail.provider = rule.provider;
    if (rule.option) detail.option = rule.option;
    push({
      kind: "dependency",
      signal: `package.json depends on "${name}"`,
      conclusion: rule.conclusion,
      capability: rule.cap,
      detail,
      weak: rule.weak,
      from: pkgPath,
    });
  }

  // Language: TypeScript if tsconfig or any .ts source.
  if (idx.first("tsconfig.json") || idx.match((p) => p.endsWith(".ts") || p.endsWith(".tsx")).length) {
    app.language ??= "typescript";
  } else {
    app.language ??= "javascript";
  }

  // Framework files corroborate web-compute independently of the dependency.
  const nextCfg = idx.first("next.config.js", "next.config.ts", "next.config.mjs", "next.config.cjs");
  if (nextCfg) {
    app.framework ??= "nextjs";
    push({
      kind: "framework-file",
      signal: `${nextCfg} present`,
      conclusion: "web-compute (Next.js)",
      capability: "web-compute",
      detail: { framework: "nextjs" },
      from: nextCfg,
    });
  }
}

// ---------------------------------------------------------------------------
// Python ecosystem
// ---------------------------------------------------------------------------

const PY_DEPS: Record<string, DepRule> = {
  fastapi: { cap: "web-compute", conclusion: "web-compute (FastAPI)", framework: "fastapi" },
  flask: { cap: "web-compute", conclusion: "web-compute (Flask)", framework: "flask" },
  django: { cap: "web-compute", conclusion: "web-compute (Django)", framework: "django" },
  uvicorn: { cap: "web-compute", conclusion: "web-compute (Uvicorn ASGI server)", weak: true },
  gunicorn: { cap: "web-compute", conclusion: "web-compute (Gunicorn WSGI server)", weak: true },

  psycopg2: { cap: "transactional-relational", conclusion: "transactional-relational (psycopg2)" },
  "psycopg2-binary": { cap: "transactional-relational", conclusion: "transactional-relational (psycopg2)" },
  psycopg: { cap: "transactional-relational", conclusion: "transactional-relational (psycopg3)" },
  asyncpg: { cap: "transactional-relational", conclusion: "transactional-relational (asyncpg)" },
  sqlalchemy: { cap: "transactional-relational", conclusion: "transactional-relational (SQLAlchemy)", weak: true },
  alembic: { cap: "transactional-relational", conclusion: "transactional-relational (Alembic migrations)" },
  pgvector: { cap: "transactional-relational", conclusion: "transactional-relational + pgvector (in-DB vectors)", option: "pgvector" },

  openai: { cap: "chat-model", conclusion: "chat-model (OpenAI SDK)", provider: "openai" },
  anthropic: { cap: "chat-model", conclusion: "chat-model (Anthropic SDK)", provider: "anthropic" },
  "azure-ai-inference": { cap: "chat-model", conclusion: "chat-model (Azure AI Inference)", provider: "azure-openai" },
  "sentence-transformers": { cap: "embeddings", conclusion: "embeddings (sentence-transformers)" },

  "azure-search-documents": { cap: "search-index", conclusion: "search-index (Azure AI Search SDK)" },
  "azure-storage-blob": { cap: "object-storage", conclusion: "object-storage (Azure Blob SDK)", provider: "azure-blob" },
  boto3: { cap: "object-storage", conclusion: "object-storage (AWS S3 SDK)", provider: "s3" },

  celery: { cap: "background-jobs", conclusion: "background-jobs (Celery)" },
  rq: { cap: "background-jobs", conclusion: "background-jobs (RQ)" },
  dramatiq: { cap: "background-jobs", conclusion: "background-jobs (Dramatiq)" },
};

function detectPython(idx: RepoIndex, app: AppInfo, push: (s: Signal) => void): void {
  const reqPath = idx.first("requirements.txt");
  const pyproject = idx.first("pyproject.toml");
  const pipfile = idx.first("Pipfile");
  const sources = [reqPath, pyproject, pipfile].filter(Boolean) as string[];
  if (!sources.length && !idx.first("manage.py")) return;

  app.runtime ??= "python";
  app.language ??= "python";

  const blob = sources.map((p) => `${idx.read(p) ?? ""}`).join("\n").toLowerCase();

  for (const [name, rule] of Object.entries(PY_DEPS)) {
    // Match as a package token (start of line or after common separators).
    const re = new RegExp(`(^|[\\s"'\\[])${escapeRe(name)}(==|>=|<=|~=|!=|\\b)`, "m");
    if (!re.test(blob)) continue;
    const detail: Record<string, unknown> = {};
    if (rule.framework) {
      detail.framework = rule.framework;
      if (!rule.weak) app.framework ??= rule.framework;
    }
    if (rule.provider) detail.provider = rule.provider;
    if (rule.option) detail.option = rule.option;
    const src = sources[0] ?? "requirements";
    push({
      kind: "dependency",
      signal: `${basename(src)} lists "${name}"`,
      conclusion: rule.conclusion,
      capability: rule.cap,
      detail,
      weak: rule.weak,
      from: src,
    });
  }

  // Django's manage.py is a strong framework-file signal on its own.
  const managePy = idx.first("manage.py");
  if (managePy) {
    app.framework ??= "django";
    app.runtime ??= "python";
    app.language ??= "python";
    push({
      kind: "framework-file",
      signal: "manage.py present",
      conclusion: "web-compute (Django)",
      capability: "web-compute",
      detail: { framework: "django" },
      from: managePy,
    });
  }
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

interface EnvRule {
  re: RegExp;
  cap: Signal["capability"];
  conclusion: string;
  provider?: string;
  option?: string;
}

const ENV_RULES: EnvRule[] = [
  { re: /^DATABASE_URL$/i, cap: "transactional-relational", conclusion: "transactional-relational (DATABASE_URL)" },
  { re: /^(POSTGRES|PG)(_)?(HOST|USER|DATABASE|DB|PASSWORD|PORT|URL)?$/i, cap: "transactional-relational", conclusion: "transactional-relational (Postgres env)" },
  { re: /^OPENAI_API_KEY$/i, cap: "chat-model", conclusion: "chat-model (OpenAI env)", provider: "openai" },
  { re: /^AZURE_OPENAI(_.*)?$/i, cap: "chat-model", conclusion: "chat-model (Azure OpenAI env)", provider: "azure-openai" },
  { re: /^ANTHROPIC_API_KEY$/i, cap: "chat-model", conclusion: "chat-model (Anthropic env)", provider: "anthropic" },
  { re: /^(AZURE_STORAGE|BLOB)(_.*)?$/i, cap: "object-storage", conclusion: "object-storage (Azure Storage env)", provider: "azure-blob" },
  { re: /^(AWS_S3|S3)(_.*)?$/i, cap: "object-storage", conclusion: "object-storage (S3 env)", provider: "s3" },
  { re: /^(AZURE_SEARCH|AZURE_AISEARCH|SEARCH_ENDPOINT)(_.*)?$/i, cap: "search-index", conclusion: "search-index (Azure AI Search env)" },
];

function detectEnv(idx: RepoIndex, push: (s: Signal) => void): void {
  const envFiles = idx.match((p) => {
    const b = basename(p);
    return b === ".env" || b.startsWith(".env");
  });
  for (const file of envFiles) {
    const text = idx.read(file);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/i.exec(line);
      if (!m) continue;
      const key = m[1] ?? "";
      const value = (m[2] ?? "").trim();
      for (const rule of ENV_RULES) {
        if (!rule.re.test(key)) continue;
        const strongPg = rule.cap === "transactional-relational" && /postgres/i.test(value);
        const detail: Record<string, unknown> = {};
        if (rule.provider) detail.provider = rule.provider;
        if (rule.option) detail.option = rule.option;
        push({
          kind: "env",
          signal: `${basename(file)} sets ${key}`,
          conclusion: rule.conclusion,
          capability: rule.cap,
          detail,
          // A bare env var is weak unless the value confirms it (e.g. postgres://).
          weak: !strongPg && rule.cap === "transactional-relational" ? true : false,
          from: file,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

function detectMigrations(idx: RepoIndex, push: (s: Signal) => void): void {
  // Prisma
  const prismaMigrations = idx.match((p) => p.startsWith("prisma/migrations/") && p.endsWith(".sql"));
  const prismaSchema = idx.first("prisma/schema.prisma");
  if (prismaMigrations.length || prismaSchema) {
    const from = prismaMigrations[0] ?? prismaSchema!;
    push({
      kind: "migration",
      signal: prismaMigrations.length ? `${prismaMigrations.length} Prisma migration file(s)` : "prisma/schema.prisma present",
      conclusion: "transactional-relational (Prisma schema/migrations)",
      capability: "transactional-relational",
      from,
    });
    if (prismaSchema) {
      const schema = idx.read(prismaSchema) ?? "";
      if (/provider\s*=\s*"postgresql"/i.test(schema)) {
        push({
          kind: "config",
          signal: `schema.prisma provider = "postgresql"`,
          conclusion: "transactional-relational (Postgres)",
          capability: "transactional-relational",
          from: prismaSchema,
        });
      }
    }
  }

  // Alembic
  if (idx.first("alembic.ini") || idx.match((p) => /(^|\/)alembic\/versions\/.*\.py$/.test(p)).length) {
    const from = idx.first("alembic.ini") ?? idx.match((p) => /alembic\/versions\/.*\.py$/.test(p))[0]!;
    push({
      kind: "migration",
      signal: "Alembic migrations present",
      conclusion: "transactional-relational (Alembic)",
      capability: "transactional-relational",
      from,
    });
  }

  // Django migrations (exclude __init__.py)
  const djangoMig = idx.match((p) => /\/migrations\/\d{4}_.*\.py$/.test(p));
  if (djangoMig.length) {
    push({
      kind: "migration",
      signal: `${djangoMig.length} Django migration file(s)`,
      conclusion: "transactional-relational (Django ORM migrations)",
      capability: "transactional-relational",
      from: djangoMig[0]!,
    });
  }

  // Raw SQL migrations + pgvector extension detection
  const sqlFiles = idx.match((p) => p.endsWith(".sql"));
  for (const f of sqlFiles) {
    const text = idx.read(f);
    if (!text) continue;
    if (/create\s+extension\s+(if\s+not\s+exists\s+)?"?vector"?/i.test(text)) {
      push({
        kind: "migration",
        signal: `${f} enables the pgvector extension`,
        conclusion: "transactional-relational + pgvector (in-DB vectors)",
        capability: "transactional-relational",
        detail: { option: "pgvector" },
        from: f,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Source imports / usage
// ---------------------------------------------------------------------------

interface ImportRule {
  re: RegExp;
  cap: Signal["capability"];
  conclusion: string;
  provider?: string;
  option?: string;
}

const IMPORT_RULES: ImportRule[] = [
  { re: /\.embeddings\.create|embeddings\.create\(|client\.embeddings/i, cap: "embeddings", conclusion: "embeddings (OpenAI embeddings API call)", provider: "openai" },
  { re: /from\s+["']openai["']|require\(["']openai["']\)|import\s+OpenAI\b|from\s+openai\s+import|import\s+openai\b/i, cap: "chat-model", conclusion: "chat-model (OpenAI usage)", provider: "openai" },
  { re: /@anthropic-ai\/sdk|from\s+anthropic\s+import|import\s+anthropic\b|new\s+Anthropic\(/i, cap: "chat-model", conclusion: "chat-model (Anthropic usage)", provider: "anthropic" },
  { re: /@azure\/openai|AzureOpenAI\(|azure\.ai\.inference/i, cap: "chat-model", conclusion: "chat-model (Azure OpenAI usage)", provider: "azure-openai" },
  { re: /@azure\/storage-blob|BlobServiceClient|azure\.storage\.blob/i, cap: "object-storage", conclusion: "object-storage (Azure Blob usage)", provider: "azure-blob" },
  { re: /@azure\/search-documents|azure\.search\.documents|SearchClient\(/i, cap: "search-index", conclusion: "search-index (Azure AI Search usage)" },
  { re: /from\s+fastapi\s+import|FastAPI\(/i, cap: "web-compute", conclusion: "web-compute (FastAPI app object)", provider: undefined },
];

/** Recognized model identifiers, captured so guardrails can vet them later. */
const MODEL_RE =
  /\b(gpt-4o(?:-mini)?|gpt-4\.1(?:-mini|-nano)?|gpt-4-turbo|gpt-4|gpt-3\.5-turbo|o1(?:-mini|-preview)?|o3(?:-mini)?|text-embedding-3-(?:small|large)|text-embedding-ada-002|claude-3(?:\.5)?-(?:opus|sonnet|haiku)[a-z0-9-]*)\b/gi;

function extractModels(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MODEL_RE)) found.add(m[1] ?? m[0]);
  return [...found].sort();
}

function detectSourceImports(idx: RepoIndex, push: (s: Signal) => void): void {
  const sourceFiles = idx.match(
    (p) => /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(p) && !p.includes("/test") && !p.startsWith("test/"),
  );
  // Track which (cap+provider) we've already reported to avoid noise.
  const emitted = new Set<string>();
  for (const f of sourceFiles) {
    const text = idx.read(f);
    if (!text) continue;
    for (const rule of IMPORT_RULES) {
      const key = `${rule.cap}|${rule.conclusion}`;
      if (emitted.has(key)) continue;
      if (!rule.re.test(text)) continue;
      emitted.add(key);
      const detail: Record<string, unknown> = {};
      if (rule.provider) detail.provider = rule.provider;
      if (rule.option) detail.option = rule.option;
      if (rule.conclusion.includes("FastAPI")) detail.framework = "fastapi";
      if (rule.cap === "chat-model" || rule.cap === "embeddings") {
        const models = extractModels(text);
        if (models.length) detail.models = models;
      }
      push({
        kind: "import",
        signal: `${f} imports/uses ${describeRule(rule)}`,
        conclusion: rule.conclusion,
        capability: rule.cap,
        detail,
        from: f,
      });
    }
  }
}

function describeRule(rule: ImportRule): string {
  if (rule.provider) return rule.provider;
  if (rule.conclusion.includes("FastAPI")) return "fastapi";
  return rule.cap ?? "capability";
}

// ---------------------------------------------------------------------------
// Container / deploy conventions
// ---------------------------------------------------------------------------

function detectContainer(idx: RepoIndex, app: AppInfo, push: (s: Signal) => void): void {
  const dockerfiles = idx.match((p) => basename(p) === "Dockerfile" || basename(p).startsWith("Dockerfile"));
  if (dockerfiles.length) {
    push({
      kind: "dockerfile",
      signal: `${dockerfiles[0]} present`,
      conclusion: "web-compute (containerized → Container Apps)",
      capability: "web-compute",
      detail: { container: true },
      from: dockerfiles[0]!,
    });
  }
}

function detectCi(idx: RepoIndex, push: (s: Signal) => void): void {
  const workflows = idx.match((p) => /^\.github\/workflows\/.*\.(yml|yaml)$/.test(p));
  if (!workflows.length) return;
  push({
    kind: "ci",
    signal: `${workflows.length} GitHub Actions workflow(s)`,
    conclusion: "CI/CD via GitHub Actions (deploy convention)",
    capability: "web-compute",
    detail: { ci: "github-actions" },
    weak: true,
    from: workflows[0]!,
  });
  // Look for explicit Azure deploy steps to raise confidence in web-compute target.
  for (const wf of workflows) {
    const text = idx.read(wf) ?? "";
    if (/azure\/container-apps-deploy|azure\/webapps-deploy|azure\/aci-deploy|azd\s+up|az\s+containerapp/i.test(text)) {
      push({
        kind: "ci",
        signal: `${wf} deploys to Azure`,
        conclusion: "web-compute (Azure deploy target in CI)",
        capability: "web-compute",
        detail: { ci: "github-actions", azure: true },
        from: wf,
      });
      break;
    }
  }
}

function detectDeployConventions(idx: RepoIndex, push: (s: Signal) => void): void {
  const azdConfig = idx.first("azure.yaml", "azure.yml");
  if (azdConfig) {
    push({
      kind: "config",
      signal: `${azdConfig} present (azd)`,
      conclusion: "web-compute (Azure Developer CLI convention)",
      capability: "web-compute",
      detail: { deploy: "azd" },
      from: azdConfig,
    });
  }

  // Vercel is the most common host for Next.js/Node apps. azx reads a Vercel
  // project as a *migration source*: the app is web-compute on Vercel today, and
  // its Azure equivalent is Container Apps. The committed `vercel.json` is the
  // portable marker; `.vercel/project.json` is the linked-project fallback.
  const vercelConfig = idx.first("vercel.json", ".vercel/project.json");
  if (vercelConfig) {
    push({
      kind: "config",
      signal: `${vercelConfig} present (Vercel)`,
      conclusion: "web-compute (migrating from Vercel → Azure Container Apps)",
      capability: "web-compute",
      detail: { deploy: "vercel", from: "vercel", migration: true },
      from: vercelConfig,
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
