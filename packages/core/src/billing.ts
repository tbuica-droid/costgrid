import { mulDiv, type Nanodollars, usd } from "./money.js";

/**
 * What CostGrid charges its own customers.
 *
 * Deliberately separate from the *metering* of a customer's provider spend.
 * Conflating "what your AI cost you" with "what we charge you for telling you"
 * is how a FinOps vendor loses the trust its numbers depend on — the two
 * appear as distinct lines everywhere.
 *
 * This computes an invoice basis. It does not talk to a payment processor;
 * charging a card is a decision with real-world consequences that belongs
 * behind an explicit integration, not a library function.
 */

export type PlanId = "free" | "team" | "business";

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** Charged every month regardless of usage. */
  readonly monthlyBase: Nanodollars;
  /**
   * Share of the customer's metered provider spend, in basis points.
   *
   * Priced as a fraction of spend because that is what the product acts on:
   * a customer whose bill CostGrid halves should pay less, not the same.
   */
  readonly spendFeeBps: number;
  /** Metered calls included before the platform stops accepting traffic. */
  readonly includedCallsPerMonth: number;
  /** Requests per minute, per tenant, at the gateway. */
  readonly rateLimitPerMinute: number;
  readonly seats: number;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    name: "Free",
    monthlyBase: 0n,
    spendFeeBps: 0,
    includedCallsPerMonth: 10_000,
    rateLimitPerMinute: 60,
    seats: 2,
  },
  team: {
    id: "team",
    name: "Team",
    monthlyBase: usd("99.00"),
    spendFeeBps: 200, // 2% of metered spend
    includedCallsPerMonth: 1_000_000,
    rateLimitPerMinute: 600,
    seats: 10,
  },
  business: {
    id: "business",
    name: "Business",
    monthlyBase: usd("499.00"),
    spendFeeBps: 100, // 1% — the rate falls as volume rises
    includedCallsPerMonth: 20_000_000,
    rateLimitPerMinute: 6_000,
    seats: 100,
  },
};

export function planFor(id: string): Plan {
  const plan = PLANS[id as PlanId];
  if (!plan) throw new RangeError(`unknown plan: ${id}`);
  return plan;
}

export function isPlanId(id: string): id is PlanId {
  return id in PLANS;
}

export interface InvoiceBasis {
  readonly plan: Plan;
  /** The customer's own provider spend over the period, as metered. */
  readonly meteredSpend: Nanodollars;
  readonly calls: number;
  /** Fixed monthly charge. */
  readonly base: Nanodollars;
  /** Usage component, derived from metered spend. */
  readonly spendFee: Nanodollars;
  readonly total: Nanodollars;
  /** Calls beyond the plan's allowance; zero when within it. */
  readonly overageCalls: number;
  readonly withinAllowance: boolean;
}

/**
 * Compute what a tenant owes for a period.
 *
 * Exact integer arithmetic throughout, for the same reason the metering path
 * uses it: an invoice that disagrees with its own line items by a cent invites
 * a dispute the vendor always loses.
 */
export function computeInvoice(
  planId: PlanId,
  meteredSpend: Nanodollars,
  calls: number,
): InvoiceBasis {
  const plan = planFor(planId);
  if (!Number.isInteger(calls) || calls < 0) {
    throw new RangeError(`calls must be a non-negative integer, got ${calls}`);
  }
  if (meteredSpend < 0n) {
    throw new RangeError(`metered spend cannot be negative, got ${meteredSpend}`);
  }

  const spendFee = mulDiv(meteredSpend, BigInt(plan.spendFeeBps), 10_000n);
  const overageCalls = Math.max(0, calls - plan.includedCallsPerMonth);

  return {
    plan,
    meteredSpend,
    calls,
    base: plan.monthlyBase,
    spendFee,
    total: plan.monthlyBase + spendFee,
    overageCalls,
    withinAllowance: overageCalls === 0,
  };
}
