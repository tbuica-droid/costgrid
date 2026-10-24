import { mulDiv, NANO_PER_USD } from "./money.js";

/**
 * An exact rational, for the figures CostGrid reports as a quotient: cost per
 * successful outcome, shares of spend, success rates.
 *
 * Dividing two bigints truncates, and dividing two floats drifts, and either
 * would make a published LCSO figure impossible to re-perform to the last
 * digit. So the quotient is never taken: the numerator and denominator are
 * carried as they were summed, compared by cross-multiplication, and rounded
 * once, at the point of display.
 *
 * Not reduced to lowest terms. `3040/7800` stays as the sums that produced
 * it, which is what an auditor re-performing the arithmetic expects to see.
 */
export interface Ratio {
  readonly num: bigint;
  /** Always positive. */
  readonly den: bigint;
}

export function ratio(num: bigint, den: bigint): Ratio {
  if (den === 0n) throw new RangeError("ratio with a zero denominator");
  return den < 0n ? { num: -num, den: -den } : { num, den };
}

export function compareRatio(a: Ratio, b: Ratio): -1 | 0 | 1 {
  // Both denominators are positive, so cross-multiplying preserves order.
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Equal as numbers: 1/2 equals 2/4. */
export function ratioEquals(a: Ratio, b: Ratio): boolean {
  return compareRatio(a, b) === 0;
}

/** Decimal string rounded half away from zero, e.g. 71/22 at 1 place is "3.2". */
export function formatRatio(r: Ratio, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`decimals must be an integer 0..18, got ${decimals}`);
  }
  const scaled = mulDiv(r.num, 10n ** BigInt(decimals), r.den);
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const rendered = decimals === 0 ? whole : `${whole}.${digits.slice(-decimals)}`;
  return negative ? `-${rendered}` : rendered;
}

/** A share as a percentage without the sign: 1160/3040 at 1 place is "38.2". */
export function formatPercent(r: Ratio, decimals: number): string {
  return formatRatio(ratio(r.num * 100n, r.den), decimals);
}

/**
 * A ratio of nanodollars per outcome as dollars, rounded: "0.390".
 *
 * `toUsdString` truncates, which is right for a ledger amount but would
 * understate a cost per outcome shown to three places, so this rounds instead.
 */
export function formatUsdPerOutcome(r: Ratio, decimals = 3): string {
  return formatRatio(ratio(r.num, r.den * NANO_PER_USD), decimals);
}

/**
 * Lossy conversion to a float, for display and charting only.
 * Never feed the result back into a computation.
 */
export function ratioToNumber(r: Ratio): number {
  return Number(r.num) / Number(r.den);
}
