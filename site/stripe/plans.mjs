/**
 * Marketing-site plan ids. These are the words on the pricing cards.
 *
 * packages/core/src/billing.ts uses different ids for the same monthly fees:
 * site "pro" is $99, which billing.ts calls "team", and site "team" is $499,
 * which billing.ts calls "business". How those two vocabularies meet is an
 * open decision. This module does not import or change billing.ts.
 */
export const LOOKUP_KEYS = {
  pro: "costgrid_pro_monthly",
  team: "costgrid_team_monthly",
};

export const PLAN_BY_LOOKUP_KEY = {
  costgrid_pro_monthly: "pro",
  costgrid_team_monthly: "team",
};

export const SITE_PLANS = ["pro", "team"];

/** Statuses that keep the paid plan. Stripe may still be retrying a past_due invoice. */
export const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

export const KNOWN_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
  "refunded",
]);

export function isSitePlan(value) {
  return SITE_PLANS.includes(value);
}

export function planFromLookupKey(lookupKey) {
  if (!lookupKey) return null;
  return PLAN_BY_LOOKUP_KEY[lookupKey] || null;
}

/**
 * What to store for a subscription status.
 * A status we don't recognise is thrown, so the event is retried instead of
 * being written into a column the check constraint would reject.
 */
export function entitlementFor(status, lookupKey) {
  if (!KNOWN_STATUSES.has(status)) {
    const error = new Error(`Unexpected subscription status: ${status || "missing"}`);
    error.code = "unknown_status";
    throw error;
  }
  if (!ENTITLED_STATUSES.has(status)) {
    return { plan: "free", plan_status: status };
  }
  const plan = planFromLookupKey(lookupKey);
  if (!plan) {
    const error = new Error(`No CostGrid plan for price lookup_key ${lookupKey || "(missing)"}`);
    error.code = "unmapped_price";
    throw error;
  }
  return { plan, plan_status: status };
}
