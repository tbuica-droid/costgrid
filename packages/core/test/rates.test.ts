import { describe, expect, it } from "vitest";
import { usd } from "../src/money.js";
import {
  applyRate,
  applyRateTo,
  deriveRate,
  isPlausibleRate,
  rateFromDiscountPercent,
  type RateOverride,
} from "../src/rates.js";

const cost = {
  input: usd("10.00"),
  output: usd("30.00"),
  cacheWrite: usd("2.00"),
  cacheRead: usd("1.00"),
  total: usd("43.00"),
};

describe("rate overrides", () => {
  it("scales every bucket so the parts still add to the whole", () => {
    const rate = rateFromDiscountPercent("anthropic", 20);
    const discounted = applyRate(cost, rate);

    expect(discounted.total).toBe(usd("34.40"));
    // The defect this feature exists to remove: a breakdown that disagrees
    // with its own total.
    expect(discounted.input + discounted.output + discounted.cacheWrite + discounted.cacheRead).toBe(
      discounted.total,
    );
  });

  it("is exact on a rate no float could hold", () => {
    // A third off, applied to a prime-ish amount: float arithmetic drifts here.
    const rate: RateOverride = {
      provider: "anthropic",
      numerator: 2n,
      denominator: 3n,
      source: "manual",
    };
    const scaled = applyRate({ ...cost, input: 1n, output: 1n, cacheWrite: 1n, cacheRead: 1n }, rate);
    // 1 nanodollar at two-thirds rounds half away from zero, every time.
    expect(scaled.input).toBe(1n);
    expect(scaled.total).toBe(4n);
  });

  it("leaves an unpriced or undiscounted call exactly as it was", () => {
    expect(applyRate(cost, undefined)).toBe(cost);
    expect(applyRateTo(usd("5.00"), undefined)).toBe(usd("5.00"));
  });

  it("keeps the sign of a saving that went the wrong way", () => {
    // A route can make a call more expensive, and a discount must not hide it.
    expect(applyRateTo(usd("-4.00"), rateFromDiscountPercent("anthropic", 50))).toBe(usd("-2.00"));
  });

  it("converts a percentage without losing the fractional part", () => {
    const rate = rateFromDiscountPercent("openai", 18.5);
    expect(rate.numerator).toBe(8_150n);
    expect(rate.denominator).toBe(10_000n);
    expect(applyRate(cost, rate).total).toBe(usd("35.045"));
  });

  it("rejects a percentage that is not a discount", () => {
    for (const bad of [-1, 100, 150, Number.NaN]) {
      expect(() => rateFromDiscountPercent("anthropic", bad)).toThrow(/discount must be/);
    }
  });

  // ------------------------------------------------------------- derivation

  it("derives a rate from what the provider actually billed", () => {
    const rate = deriveRate("anthropic", usd("820.00"), usd("1000.00"));
    expect(rate?.source).toBe("derived");
    expect(applyRate(cost, rate).total).toBe(usd("35.26")); // 43 x 0.82
  });

  /*
   * The guard that matters. A mis-parsed cost report or a mismatched window
   * produces a ratio nobody negotiated, and applying it would corrupt every
   * figure CostGrid reports. Refusing is recoverable; silently mis-pricing a
   * year of history is not.
   */
  it("refuses a ratio nobody could have negotiated", () => {
    expect(deriveRate("anthropic", usd("1.00"), usd("1000.00"))).toBeUndefined(); // 99.9% off
    expect(deriveRate("anthropic", usd("5000.00"), usd("1000.00"))).toBeUndefined(); // 5x list
    expect(deriveRate("anthropic", usd("100.00"), 0n)).toBeUndefined(); // no basis
    expect(deriveRate("anthropic", usd("-5.00"), usd("100.00"))).toBeUndefined();
  });

  it("accepts list price itself as a rate", () => {
    // A customer with no discount is not an error, and 1.0 must round-trip.
    const rate = deriveRate("openai", usd("100.00"), usd("100.00"));
    expect(rate).toBeDefined();
    expect(applyRate(cost, rate).total).toBe(cost.total);
  });

  it("guards a malformed override", () => {
    expect(isPlausibleRate({ provider: "a", numerator: 1n, denominator: 0n, source: "manual" })).toBe(false);
    expect(isPlausibleRate({ provider: "a", numerator: -1n, denominator: 1n, source: "manual" })).toBe(false);
  });
});
