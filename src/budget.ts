/**
 * Stage [1] budget — Node adapter over the browser-safe {@link ./budget-core.js}.
 *
 * In production budget context comes from the subscription; in this POC we read a
 * mock `.azx/subscription.json` fixture off disk — no real Azure calls. All the
 * pure classification/normalization lives in `budget-core`; this file only adds
 * the filesystem read and re-exports the core surface for existing importers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetContext } from "./types.js";
import { normalizeBudget } from "./budget-core.js";

export { classifyOffer, normalizeBudget, prefersEconomy, describeBudget } from "./budget-core.js";

/** Read the mock `.azx/subscription.json` from a repo root, if present. */
export function loadBudget(root: string): BudgetContext | undefined {
  const text = tryRead(join(root, ".azx", "subscription.json"));
  if (text === undefined) return undefined;
  let raw: Record<string, unknown>;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object") return undefined;
    raw = v as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return normalizeBudget(raw);
}

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}