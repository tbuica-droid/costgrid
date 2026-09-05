import { describe, expect, it } from "vitest";
import { toUsdString, usd } from "../src/money.js";
import { findModelPrice, listModelPrices, perMTok } from "../src/pricing.js";
import { addUsage, parseAnthropicUsage, priceUsage, totalTokens, ZERO_USAGE } from "../src/usage.js";

describe("pricing catalog", () => {
  it("prices Opus 5 at the published $5 / $25 per MTok", () => {
    const opus = findModelPrice("claude-opus-5");
    expect(opus).toBeDefined();
    // $5.00 per 1M tokens === 5000 nanodollars per token
    expect(opus?.input).toBe(5_000n);
    expect(opus?.output).toBe(25_000n);
  });

  it("derives cache rates from input: 1.25x write, 0.10x read", () => {
    const opus = findModelPrice("claude-opus-5");
    expect(opus?.cacheWrite5m).toBe(6_250n); // 1.25 * 5000
    expect(opus?.cacheWrite1h).toBe(10_000n); // 2.00 * 5000
    expect(opus?.cacheRead).toBe(500n); // 0.10 * 5000
  });

  it("honours the documented Fable 5.1 cache-read exception", () => {
    const fable = findModelPrice("claude-fable-5-1");
    expect(fable?.input).toBe(10_000n);
    // $0.25/MTok, not the 0.10x-input default of 1000n.
    expect(fable?.cacheRead).toBe(250n);
  });

  it("resolves dated snapshot ids to their base model", () => {
    expect(findModelPrice("claude-opus-5-20260401")?.id).toBe("claude-opus-5");
    expect(findModelPrice("claude-opus-4-8-20260101")?.id).toBe("claude-opus-4-8");
  });

  it("returns undefined for a model it does not know", () => {
    expect(findModelPrice("claude-opus-9")).toBeUndefined();
    expect(findModelPrice("gpt-5.5")).toBeUndefined();
  });

  it("refuses a price too fine to represent per token", () => {
    expect(() => perMTok("0.0000001")).toThrow(/finer than 1 nanodollar/);
  });

  it("gives every catalogued model a tier and a positive price", () => {
    for (const model of listModelPrices()) {
      expect(model.input).toBeGreaterThan(0n);
      expect(model.output).toBeGreaterThan(0n);
      expect(["frontier", "mid", "small", "open"]).toContain(model.tier);
    }
  });
});

describe("parseAnthropicUsage", () => {
  it("reads the flat cache_creation_input_tokens shape", () => {
    const usage = parseAnthropicUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 300,
    });
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheWrite5mTokens).toBe(200);
    expect(usage.cacheWrite1hTokens).toBe(0);
    expect(usage.cacheReadTokens).toBe(300);
  });

  it("prefers the cache_creation object, splitting 5m from 1h writes", () => {
    const usage = parseAnthropicUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 999,
      cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 },
    });
    expect(usage.cacheWrite5mTokens).toBe(40);
    expect(usage.cacheWrite1hTokens).toBe(60);
  });

  it("treats absent fields as zero", () => {
    expect(parseAnthropicUsage({ input_tokens: 5 })).toEqual({ ...ZERO_USAGE, inputTokens: 5 });
  });

  it("rejects malformed usage rather than coercing it", () => {
    expect(() => parseAnthropicUsage(null)).toThrow(/not an object/);
    expect(() => parseAnthropicUsage([])).toThrow(/not an object/);
    expect(() => parseAnthropicUsage({ input_tokens: "100" })).toThrow(/not a finite number/);
    expect(() => parseAnthropicUsage({ input_tokens: -1 })).toThrow(/non-negative integer/);
    expect(() => parseAnthropicUsage({ input_tokens: 1.5 })).toThrow(/non-negative integer/);
  });
});

describe("priceUsage", () => {
  it("charges each token bucket at its own rate", () => {
    const priced = priceUsage("claude-opus-5", {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheWrite5mTokens: 1_000,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 1_000,
    });

    expect(priced.priced).toBe(true);
    expect(priced.cost.input).toBe(usd("0.005")); // 1000 * $5/MTok
    expect(priced.cost.output).toBe(usd("0.025")); // 1000 * $25/MTok
    expect(priced.cost.cacheWrite).toBe(usd("0.00625")); // 1000 * $6.25/MTok
    expect(priced.cost.cacheRead).toBe(usd("0.0005")); // 1000 * $0.50/MTok
    expect(priced.cost.total).toBe(usd("0.03675"));
  });

  it("shows the saving a cache hit actually produces", () => {
    const uncached = priceUsage("claude-opus-5", { ...ZERO_USAGE, inputTokens: 100_000 });
    const cached = priceUsage("claude-opus-5", { ...ZERO_USAGE, cacheReadTokens: 100_000 });

    expect(toUsdString(uncached.cost.total, 2)).toBe("0.50");
    expect(toUsdString(cached.cost.total, 2)).toBe("0.05");
    expect(cached.cost.total * 10n).toBe(uncached.cost.total);
  });

  it("records an unknown model as unpriced, never as free", () => {
    const priced = priceUsage("some-model-we-have-not-catalogued", {
      ...ZERO_USAGE,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(priced.priced).toBe(false);
    expect(priced.price).toBeUndefined();
    expect(priced.cost.total).toBe(0n);
    // The usage itself is still preserved truthfully.
    expect(totalTokens(priced.usage)).toBe(2_000_000);
  });
});

describe("addUsage", () => {
  it("folds streaming deltas into a running total", () => {
    const start = parseAnthropicUsage({ input_tokens: 100, cache_read_input_tokens: 20 });
    const delta = parseAnthropicUsage({ output_tokens: 250 });
    const total = addUsage(start, delta);

    expect(total.inputTokens).toBe(100);
    expect(total.cacheReadTokens).toBe(20);
    expect(total.outputTokens).toBe(250);
    expect(totalTokens(total)).toBe(370);
  });
});
