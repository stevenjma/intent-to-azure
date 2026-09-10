/**
 * Stage [1] guardrails — load and apply `guardrails.yaml`.
 *
 * Guardrails are policy. When the repo and policy disagree, **policy wins**:
 * an approved-models allow-list drops disallowed models, an allowed-regions list
 * pins the region, a spend cap arms the budget check. Loading is offline.
 * Missing implicit files are optional; malformed or unreadable policy fails closed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Guardrails } from "./types.js";

/** Read `guardrails.yaml` (or `.azx/guardrails.yaml`) from a repo root, if present. */
export function loadGuardrails(root: string): Guardrails | undefined {
  for (const rel of ["guardrails.yaml", "guardrails.yml", ".azx/guardrails.yaml", ".azx/guardrails.yml"]) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`cannot read guardrails file ${path}: ${(err as Error).message}`);
    }
    return parseGuardrails(text, path);
  }
  return undefined;
}

/** Parse guardrails from a YAML string (used by the CLI `--guardrails` flag). */
export function parseGuardrails(text: string, source = "<guardrails>"): Guardrails {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new Error(`invalid guardrails YAML in ${source}: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`invalid guardrails in ${source}: root must be a mapping`);
  return normalizeGuardrails(parsed, source);
}

/** Coerce a parsed object into a well-typed {@link Guardrails}. */
function normalizeGuardrails(raw: Record<string, unknown>, source: string): Guardrails {
  rejectUnknown(raw, ["regions", "approvedModels", "approved_models", "budget", "skuTier", "sku_tier", "notes"], source);
  const g: Guardrails = {};
  const regions = stringArray(raw.regions, "regions", source);
  if (raw.regions !== undefined && regions.length === 0) {
    throw new Error(`invalid guardrails in ${source}: regions must contain at least one value`);
  }
  if (regions.length) g.regions = regions;

  const approvedModelsValue = raw.approvedModels ?? raw.approved_models;
  const approvedModels = stringArray(approvedModelsValue, "approvedModels", source);
  if (approvedModelsValue !== undefined && approvedModels.length === 0) {
    throw new Error(`invalid guardrails in ${source}: approvedModels must contain at least one value`);
  }
  if (approvedModels.length) g.approvedModels = approvedModels;

  if (raw.budget !== undefined && !isRecord(raw.budget)) {
    throw new Error(`invalid guardrails in ${source}: budget must be a mapping`);
  }
  const budget = (raw.budget ?? {}) as Record<string, unknown>;
  rejectUnknown(budget, ["monthlyCapUsd", "monthly_cap_usd", "onExceed", "on_exceed"], `${source} (budget)`);
  const cap = numberValue(budget.monthlyCapUsd ?? budget.monthly_cap_usd, "budget.monthlyCapUsd", source);
  const onExceed = budget.onExceed ?? budget.on_exceed;
  if (onExceed !== undefined && onExceed !== "warn" && onExceed !== "block") {
    throw new Error(`invalid guardrails in ${source}: budget.onExceed must be "warn" or "block"`);
  }
  if (cap !== undefined || onExceed === "warn" || onExceed === "block") {
    g.budget = {};
    if (cap !== undefined) g.budget.monthlyCapUsd = cap;
    if (onExceed === "warn" || onExceed === "block") g.budget.onExceed = onExceed;
  }

  const skuTier = raw.skuTier ?? raw.sku_tier;
  if (skuTier !== undefined && skuTier !== "economy" && skuTier !== "standard") {
    throw new Error(`invalid guardrails in ${source}: skuTier must be "economy" or "standard"`);
  }
  if (skuTier === "economy" || skuTier === "standard") g.skuTier = skuTier;

  const notes = stringArray(raw.notes, "notes", source);
  if (notes.length) g.notes = notes;
  return g;
}

function stringArray(v: unknown, field: string, source: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0)) {
    throw new Error(`invalid guardrails in ${source}: ${field} must be an array of non-empty strings`);
  }
  return v as string[];
}

function numberValue(v: unknown, field: string, source: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error(`invalid guardrails in ${source}: ${field} must be a finite non-negative number`);
  }
  return v;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(raw: Record<string, unknown>, allowed: string[], source: string): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new Error(`invalid guardrails in ${source}: unknown field(s): ${unknown.join(", ")}`);
  }
}
