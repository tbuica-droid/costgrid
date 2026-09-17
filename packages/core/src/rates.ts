import { mulDiv, type Nanodollars } from "./money.js";
import type { CostBreakdown } from "./usage.js";

/**
 * A negotiated rate, expressed as an exact rational rather than a percentage.
 *
 * Enterprise agreements are priced off list: a committed-spend discount, a
 * partner rate, a bundled credit. CostGrid's catalog only knows list, so a
 * customer on 18% off watches it report 18% more than their invoice — the
 * worst possible discrepancy for a product whose pitch is cost truth.
 *
 * Stored as numerator/denominator, never a float. A discount of 18% is 82/100;
 * one derived from observed billing is the two observed totals themselves,
 * which makes the override its own evidence. Both go through `mulDiv`, which
 * rounds half away from zero, so a discounted bill cannot drift from repeated
 * rounding the way a float multiplier would.
 */
export interface RateOverride {
  readonly provider: string;
  readonly numerator: bigint;
  readonly denominator: bigint;
  /**
   * `manual` — the customer told us their rate.
   * `derived` — computed from what the provider actually billed them.
   */
  readonly source: "manual" | "derived";
}

/**
 * The widest ratio worth believing.
 *
 * Nobody negotiates 95% off, and nothing legitimate bills at triple list. A
 * ratio outside this band is a mis-parse or a mismatched window, and applying
 * it would corrupt every figure CostGrid reports. Refusing is recoverable;
 * silently mis-pricing a year of history is not.
 */
export const MIN_RATE_RATIO = 0.05;
export const MAX_RATE_RATIO = 1.5;

export function rateRatio(override: RateOverride): number {
  return Number(override.numerator) / Number(override.denominator);
}

/**
 * The discount as a percentage, for display only.
 *
 * Rounded at source. `1 - 8200/10000` is 18.000000000000004 in binary
 * floating point, and a statement that says "18.000000000000004% off" is not
 * a statement anyone trusts with their invoice. The arithmetic that touches
 * money never goes near this — it stays an exact rational.
 */
export function discountPercent(override: RateOverride): number {
  return Math.round((1 - rateRatio(override)) * 10_000) / 100;
}

export function isPlausibleRate(override: RateOverride): boolean {
  if (override.denominator <= 0n || override.numerator < 0n) return false;
  const ratio = rateRatio(override);
  return ratio >= MIN_RATE_RATIO && ratio <= MAX_RATE_RATIO;
}

/** A discount percentage (18 means 18% off list) as an exact override. */
export function rateFromDiscountPercent(provider: string, percent: number): RateOverride {
  if (!Number.isFinite(percent) || percent < 0 || percent >= 100) {
    throw new RangeError(`discount must be 0..99.99, got ${percent}`);
  }
  // Two decimal places of precision, kept in integers: 18.5% -> 8150/10000.
  const hundredths = BigInt(Math.round((100 - percent) * 100));
  return { provider, numerator: hundredths, denominator: 10_000n, source: "manual" };
}

/**
 * Apply a rate to a priced call.
 *
 * Every bucket is scaled and the total re-summed from the scaled buckets, so
 * the parts still add to the whole. Scaling the total on its own would leave a
 * breakdown whose rows do not reconcile with it — which is exactly the defect
 * this feature exists to remove.
 */
export function applyRate(cost: CostBreakdown, override: RateOverride | undefined): CostBreakdown {
  if (override === undefined) return cost;

  const scale = (value: Nanodollars): Nanodollars =>
    mulDiv(value, override.numerator, override.denominator);

  const input = scale(cost.input);
  const output = scale(cost.output);
  const cacheWrite = scale(cost.cacheWrite);
  const cacheRead = scale(cost.cacheRead);

  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

/** Apply a rate to a single signed amount, such as a routing saving. */
export function applyRateTo(
  value: Nanodollars,
  override: RateOverride | undefined,
): Nanodollars {
  return override === undefined ? value : mulDiv(value, override.numerator, override.denominator);
}

/**
 * Derive a rate from what the provider actually charged.
 *
 * `reported` is the provider's own figure over a window; `catalog` is what
 * CostGrid's list prices made of the same usage. Their ratio is the customer's
 * effective rate — not read off a contract, but observed from two numbers they
 * can both check.
 *
 * Deliberately blended across models. A discount that applies unevenly is
 * approximated here, which is why the result is labelled derived everywhere it
 * surfaces and the evidence travels with it.
 */
export function deriveRate(
  provider: string,
  reported: Nanodollars,
  catalog: Nanodollars,
): RateOverride | undefined {
  if (catalog <= 0n || reported < 0n) return undefined;
  const override: RateOverride = {
    provider,
    numerator: reported,
    denominator: catalog,
    source: "derived",
  };
  return isPlausibleRate(override) ? override : undefined;
}
