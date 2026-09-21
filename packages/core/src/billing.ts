import { type Nanodollars, usd } from "./money.js";

/**
 * What CostGrid charges its own customers.
 *
 * A flat monthly fee and nothing else. No share of the customer's spend, and
 * no per-call metering.
 *
 * The spend share was removed deliberately and should not come back. This
 * product exists to reduce a customer's AI bill, so charging a percentage of
 * that bill meant the better it worked the less it earned, and any buyer who
 * did the arithmetic could see we were paid to save them less. A product whose
 * entire claim is honest numbers cannot hold a contradiction like that in its
 * price list.
 *
 * Per-call allowances went with it for a plainer reason: CostGrid is
 * self-hosted. The customer runs the binary and holds the database, so we
 * cannot count their calls, and an allowance nobody can measure is not a term,
 * it is decoration. It is also a real advantage, since every hosted competitor
 * meters requests because they are storing them.
 *
 * Deliberately separate from the *metering* of a customer's provider spend.
 * Conflating "what your AI cost you" with "what we charge you for telling you"
 * is how a FinOps vendor loses the trust its numbers depend on: the two
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
   * Requests per minute, per tenant, at the gateway.
   *
   * An abuse guard, not a meter. Nothing here is billed by volume.
   */
  readonly rateLimitPerMinute: number;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    name: "Free",
    monthlyBase: 0n,
    rateLimitPerMinute: 60,
  },
  team: {
    id: "team",
    name: "Team",
    monthlyBase: usd("99.00"),
    rateLimitPerMinute: 600,
  },
  business: {
    id: "business",
    name: "Business",
    monthlyBase: usd("499.00"),
    rateLimitPerMinute: 6_000,
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
  /**
   * The customer's own provider spend over the period, as metered.
   *
   * Carried for the invoice to show beside the charge, never to compute it.
   * Seeing "you spent $8,400 on AI, we charged you $99" is the whole argument
   * for the product on one line.
   */
  readonly meteredSpend: Nanodollars;
  readonly calls: number;
  readonly total: Nanodollars;
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

  return {
    plan,
    meteredSpend,
    calls,
    total: plan.monthlyBase,
  };
}
