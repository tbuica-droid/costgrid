import { describe, expect, it } from "vitest";
import { mulDiv, usd } from "../src/money.js";
import {
  CATALOG_STALE_AFTER_DAYS,
  CATALOG_VERIFIED_AT,
  catalogAgeDays,
  effectiveRates,
  findModelPrice,
  isCatalogStale,
  listModelPrices,
} from "../src/pricing.js";
import { parseAnthropicModifiers, priceUsage, ZERO_USAGE } from "../src/usage.js";

const opus = findModelPrice("claude-opus-5")!;
const sonnet = findModelPrice("claude-sonnet-5")!;
const fable = findModelPrice("claude-fable-5-1")!;

/** 1M input + 1M output tokens, so a rate reads directly as dollars. */
const ONE_M_EACH = { ...ZERO_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 };

describe("mulDiv", () => {
  it("rounds half away from zero rather than truncating", () => {
    // Truncation would bias every inexact rate downward, always in the
    // customer's favour and always wrong.
    expect(mulDiv(5n, 1n, 2n)).toBe(3n);
    expect(mulDiv(3n, 1n, 2n)).toBe(2n);
    expect(mulDiv(-5n, 1n, 2n)).toBe(-3n);
    expect(mulDiv(4n, 1n, 2n)).toBe(2n);
  });

  it("is exact when the division is exact", () => {
    expect(mulDiv(5_000n, 11n, 10n)).toBe(5_500n);
    expect(mulDiv(5_000n, 1n, 2n)).toBe(2_500n);
    expect(mulDiv(5_000n, 5n, 4n)).toBe(6_250n);
  });

  it("refuses division by zero", () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(/division by zero/);
  });
});

describe("catalog provenance", () => {
  it("records where and when the prices came from", () => {
    expect(CATALOG_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(catalogAgeDays(new Date(`${CATALOG_VERIFIED_AT}T00:00:00Z`))).toBe(0);
  });

  it("goes stale past the freshness window", () => {
    const verified = Date.parse(`${CATALOG_VERIFIED_AT}T00:00:00Z`);
    const justInside = new Date(verified + CATALOG_STALE_AFTER_DAYS * 86_400_000);
    const justOutside = new Date(verified + (CATALOG_STALE_AFTER_DAYS + 1) * 86_400_000);

    expect(isCatalogStale(justInside)).toBe(false);
    expect(isCatalogStale(justOutside)).toBe(true);
  });
});

describe("catalog coverage", () => {
  it("prices every currently served first-party model", () => {
    // A model missing here records as unpriced, understating the bill.
    for (const id of [
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]) {
      expect(findModelPrice(id), id).toBeDefined();
    }
  });

  it("still prices retired models, and marks them", () => {
    const retired = findModelPrice("claude-opus-4-1")!;
    expect(retired.retired).toBe(true);
    // Historical calls still need pricing, and partner platforms still serve it.
    expect(retired.input).toBe(15_000n);
  });

  it("derives cache rates from the published multipliers", () => {
    for (const model of listModelPrices()) {
      expect(model.cacheWrite5m, model.id).toBe(mulDiv(model.input, 5n, 4n));
      expect(model.cacheWrite1h, model.id).toBe(model.input * 2n);
    }
    // Standard 0.1x…
    expect(sonnet.cacheRead).toBe(200n); // $0.20/MTok
    // …and the documented 0.025x exception.
    expect(fable.cacheRead).toBe(250n); // $0.25/MTok on a $10 input rate
  });
});

describe("fast mode", () => {
  it("bills Opus 5 at double the standard rate", () => {
    const standard = priceUsage("claude-opus-5", ONE_M_EACH);
    const fast = priceUsage("claude-opus-5", ONE_M_EACH, { speed: "fast" });

    expect(standard.cost.total).toBe(usd("30.00")); // $5 + $25
    expect(fast.cost.total).toBe(usd("60.00")); // $10 + $50
  });

  it("carries fast pricing into the cache rates", () => {
    const rates = effectiveRates(opus, { speed: "fast" });
    expect(rates.input).toBe(10_000n);
    expect(rates.cacheWrite5m).toBe(12_500n); // 1.25 x fast input
    expect(rates.cacheRead).toBe(1_000n); // 0.10 x fast input
  });

  it("ignores fast mode on a model that does not offer it", () => {
    // The API bills these at standard rates, so we must too.
    expect(sonnet.fastInput).toBeUndefined();
    expect(effectiveRates(sonnet, { speed: "fast" })).toEqual(effectiveRates(sonnet));
  });
});

describe("data residency", () => {
  it("adds 10% to every category for US-pinned inference", () => {
    const rates = effectiveRates(opus, { inferenceGeo: "us" });
    expect(rates.input).toBe(5_500n);
    expect(rates.output).toBe(27_500n);
    expect(rates.cacheWrite5m).toBe(6_875n);
    expect(rates.cacheRead).toBe(550n);
  });

  it("leaves global routing at standard rates", () => {
    expect(effectiveRates(opus, { inferenceGeo: "global" })).toEqual(effectiveRates(opus));
  });
});

describe("batch discount", () => {
  it("halves every category", () => {
    const rates = effectiveRates(opus, { batch: true });
    expect(rates.input).toBe(2_500n);
    expect(rates.output).toBe(12_500n);
    expect(rates.cacheRead).toBe(250n);
  });

  it("stacks with data residency", () => {
    // 5000 -> 5500 (x1.1) -> 2750 (x0.5)
    expect(effectiveRates(opus, { inferenceGeo: "us", batch: true }).input).toBe(2_750n);
  });
});

describe("parseAnthropicModifiers", () => {
  it("reads speed and inference_geo from a usage object", () => {
    expect(parseAnthropicModifiers({ speed: "fast", inference_geo: "us" })).toEqual({
      speed: "fast",
      inferenceGeo: "us",
    });
  });

  it("returns nothing when the fields are absent", () => {
    expect(parseAnthropicModifiers({ input_tokens: 10 })).toEqual({});
    expect(parseAnthropicModifiers(null)).toEqual({});
    expect(parseAnthropicModifiers("nope")).toEqual({});
  });

  it("ignores values it does not recognise rather than guessing", () => {
    expect(parseAnthropicModifiers({ speed: "turbo", inference_geo: "mars" })).toEqual({});
  });

  it("closes the gap it exists for: a fast call is not billed as standard", () => {
    const reported = { input_tokens: 1_000_000, output_tokens: 1_000_000, speed: "fast" };
    const naive = priceUsage("claude-opus-5", ONE_M_EACH);
    const correct = priceUsage("claude-opus-5", ONE_M_EACH, parseAnthropicModifiers(reported));

    expect(correct.cost.total).toBe(naive.cost.total * 2n);
  });
});
