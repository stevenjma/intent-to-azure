/**
 * Stage [1] budget — read subscription budget context (mocked, offline).
 *
 * In production this comes from the subscription; in this POC we read a mock
 * `.azx/subscription.json` fixture — no real Azure calls. We classify the Azure
 * Offer ID (a sponsorship offer biases the plan toward economy SKUs and warns on
 * burn) and normalize a spend cap the planner can enforce.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetContext } from "./types.js";

/**
 * Well-known Azure Offer IDs → classification. Deliberately small: unknown
 * offers stay `unknown` rather than being guessed. Sponsorship is the case the
 * spec cares about (economy SKUs + burn warning).
 */
const OFFER_CLASSIFICATION: Record<string, NonNullable<BudgetContext["classification"]>> = {
  "MS-AZR-0036P": "sponsorship", // Microsoft Azure Sponsorship
  "MS-AZR-0143P": "sponsorship", // Sponsorship (offer variant)
  "MS-AZR-0044P": "free-trial", // Free Trial
  "MS-AZR-0003P": "pay-as-you-go", // Pay-As-You-Go
  "MS-AZR-0023P": "pay-as-you-go", // Pay-As-You-Go Dev/Test
  "MS-AZR-0017P": "enterprise", // Enterprise Agreement
  "MS-AZR-0148P": "enterprise", // EA Dev/Test
};

/** Classify an Azure Offer ID. Returns `unknown` for anything off the table. */
export function classifyOffer(offerId: string | undefined): NonNullable<BudgetContext["classification"]> {
  if (!offerId) return "unknown";
  return OFFER_CLASSIFICATION[offerId.toUpperCase()] ?? "unknown";
}

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

/** Coerce a parsed subscription object into a {@link BudgetContext}. */
export function normalizeBudget(raw: Record<string, unknown>): BudgetContext {
  const budget: BudgetContext = {};
  if (typeof raw.subscriptionId === "string") budget.subscriptionId = raw.subscriptionId;
  if (typeof raw.offerId === "string") budget.offerId = raw.offerId;

  const limit = raw.spendingLimit;
  if (limit === "on" || limit === "off" || limit === "unknown") budget.spendingLimit = limit;

  const explicit = raw.classification;
  budget.classification =
    explicit === "sponsorship" ||
    explicit === "free-trial" ||
    explicit === "pay-as-you-go" ||
    explicit === "enterprise" ||
    explicit === "unknown"
      ? explicit
      : classifyOffer(budget.offerId);

  budget.currency = typeof raw.currency === "string" ? raw.currency : "USD";
  return budget;
}

/**
 * Whether the budget context should bias the plan toward the cheapest SKUs.
 * Sponsorship and free-trial subscriptions (or an active spending limit) burn a
 * fixed credit pool, so economy SKUs are the safe default.
 */
export function prefersEconomy(budget: BudgetContext | undefined): boolean {
  if (!budget) return false;
  return (
    budget.classification === "sponsorship" ||
    budget.classification === "free-trial" ||
    budget.spendingLimit === "on"
  );
}

/** A plain-English note about the budget posture, for the plan summary. */
export function describeBudget(budget: BudgetContext | undefined): string | undefined {
  if (!budget) return undefined;
  switch (budget.classification) {
    case "sponsorship":
      return "Sponsorship subscription detected — defaulting to economy SKUs and warning on burn.";
    case "free-trial":
      return "Free-trial subscription detected — defaulting to economy SKUs to preserve credit.";
    case "enterprise":
      return "Enterprise subscription detected — standard SKUs are acceptable.";
    case "pay-as-you-go":
      return "Pay-as-you-go subscription detected — standard SKUs are acceptable.";
    default:
      return undefined;
  }
}

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
