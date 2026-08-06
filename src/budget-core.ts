/**
 * Stage [1] budget-core — browser-safe budget classification and normalization.
 *
 * Pure (no `node:` imports) so it bundles for the web. The Node adapter
 * (`budget.ts`) adds `loadBudget`, which reads the mock `.azx/subscription.json`
 * off disk and hands the parsed object to `normalizeBudget` here.
 */

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

  // `currency` comes from the untrusted app repo's `.azx/subscription.json` and is
  // interpolated into a single-line Bicep `//` comment (bicep.ts), the generated
  // README, and the plan summary. A newline/backtick would break out of the comment
  // into executable Bicep, so accept only a short currency-code-shaped token.
  budget.currency =
    typeof raw.currency === "string" && /^[A-Za-z0-9$€£¥.]{1,8}$/.test(raw.currency)
      ? raw.currency
      : "USD";
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
