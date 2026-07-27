/**
 * Stage [1] guardrails — load and apply `guardrails.yaml`.
 *
 * Guardrails are policy. When the repo and policy disagree, **policy wins**:
 * an approved-models allow-list drops disallowed models, an allowed-regions list
 * pins the region, a spend cap arms the budget check. Loading is offline and
 * best-effort — a missing or malformed file yields no guardrails, not an error.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Guardrails } from "./types.js";

/** Read `guardrails.yaml` (or `.azx/guardrails.yaml`) from a repo root, if present. */
export function loadGuardrails(root: string): Guardrails | undefined {
  for (const rel of ["guardrails.yaml", "guardrails.yml", ".azx/guardrails.yaml", ".azx/guardrails.yml"]) {
    const text = tryRead(join(root, rel));
    if (text === undefined) continue;
    const parsed = safeParse(text);
    if (parsed) return normalizeGuardrails(parsed);
  }
  return undefined;
}

/** Parse guardrails from a YAML string (used by the CLI `--guardrails` flag). */
export function parseGuardrails(text: string): Guardrails | undefined {
  const parsed = safeParse(text);
  return parsed ? normalizeGuardrails(parsed) : undefined;
}

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    const v = parseYaml(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Coerce a parsed object into a well-typed {@link Guardrails}. */
function normalizeGuardrails(raw: Record<string, unknown>): Guardrails {
  const g: Guardrails = {};
  const regions = asStringArray(raw.regions);
  if (regions.length) g.regions = regions;

  const approvedModels = asStringArray(raw.approvedModels ?? raw.approved_models);
  if (approvedModels.length) g.approvedModels = approvedModels;

  const budget = (raw.budget ?? {}) as Record<string, unknown>;
  const cap = numeric(budget.monthlyCapUsd ?? budget.monthly_cap_usd);
  const onExceed = budget.onExceed ?? budget.on_exceed;
  if (cap !== undefined || onExceed === "warn" || onExceed === "block") {
    g.budget = {};
    if (cap !== undefined) g.budget.monthlyCapUsd = cap;
    if (onExceed === "warn" || onExceed === "block") g.budget.onExceed = onExceed;
  }

  const skuTier = raw.skuTier ?? raw.sku_tier;
  if (skuTier === "economy" || skuTier === "standard") g.skuTier = skuTier;

  const notes = asStringArray(raw.notes);
  if (notes.length) g.notes = notes;
  return g;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}

function numeric(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
