import { describe, expect, it } from "vitest";
import { usd } from "../src/money.js";
import { findModelPrice } from "../src/pricing.js";
import { parseAnthropicUsage, parseOpenAiUsage, priceUsage, totalTokens } from "../src/usage.js";

describe("parseOpenAiUsage", () => {
  /*
   * The single most important difference between the two providers:
   *
   *   Anthropic  input_tokens EXCLUDES cached tokens (disjoint buckets)
   *   OpenAI     prompt_tokens INCLUDES cached tokens (a total)
   *
   * Reusing the Anthropic parser on an OpenAI response bills every cached
   * token twice — once at the full input rate and once at the cache rate.
   */
  it("treats prompt_tokens as a total that includes cached tokens", () => {
    const usage = parseOpenAiUsage({
      prompt_tokens: 1_000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 800 },
    });

    expect(usage.inputTokens).toBe(200); // 1000 total - 800 cached
    expect(usage.cacheReadTokens).toBe(800);
    expect(usage.outputTokens).toBe(200);
    // Total billable tokens still reconcile to what the provider reported.
    expect(totalTokens(usage)).toBe(1_200);
  });

  it("differs from the Anthropic parser on the same numbers, as it must", () => {
    const openai = parseOpenAiUsage({
      prompt_tokens: 1_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    const anthropicShaped = parseAnthropicUsage({
      input_tokens: 1_000,
      output_tokens: 0,
      cache_read_input_tokens: 800,
    });

    expect(openai.inputTokens).toBe(200);
    expect(anthropicShaped.inputTokens).toBe(1_000);
    // Anthropic's buckets are disjoint, so its total is genuinely higher.
    expect(totalTokens(anthropicShaped)).toBe(1_800);
    expect(totalTokens(openai)).toBe(1_000);
  });

  it("reads the Responses API field names too", () => {
    const usage = parseOpenAiUsage({
      input_tokens: 500,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 300, cache_write_tokens: 50 },
    });

    expect(usage.inputTokens).toBe(150); // 500 - 300 - 50
    expect(usage.cacheReadTokens).toBe(300);
    expect(usage.cacheWrite5mTokens).toBe(50);
  });

  it("does not double-count reasoning tokens", () => {
    // reasoning_tokens are already inside completion_tokens.
    const usage = parseOpenAiUsage({
      prompt_tokens: 100,
      completion_tokens: 900,
      completion_tokens_details: { reasoning_tokens: 700 },
    });
    expect(usage.outputTokens).toBe(900);
  });

  it("handles a response with no cache details", () => {
    const usage = parseOpenAiUsage({ prompt_tokens: 50, completion_tokens: 20 });
    expect(usage.inputTokens).toBe(50);
    expect(usage.cacheReadTokens).toBe(0);
  });

  it("rejects internally inconsistent totals rather than producing a negative", () => {
    expect(() =>
      parseOpenAiUsage({
        prompt_tokens: 100,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 500 },
      }),
    ).toThrow(/inconsistent/);
  });

  it("rejects malformed usage", () => {
    expect(() => parseOpenAiUsage(null)).toThrow(/not an object/);
    expect(() => parseOpenAiUsage({ prompt_tokens: "100" })).toThrow(/not a finite number/);
  });
});

describe("OpenAI pricing", () => {
  it("prices gpt-5 at the published rates", () => {
    const gpt5 = findModelPrice("gpt-5")!;
    expect(gpt5.provider).toBe("openai");
    expect(gpt5.input).toBe(1_250n); // $1.25/MTok
    expect(gpt5.output).toBe(10_000n); // $10.00/MTok
    expect(gpt5.cacheRead).toBe(125n); // $0.125/MTok — published, not derived
  });

  it("uses each model's published cache rate rather than one multiplier", () => {
    // gpt-4o reads at 0.5x input; gpt-5 at 0.1x. A single multiplier would
    // misprice most of the table.
    const gpt4o = findModelPrice("gpt-4o")!;
    expect(gpt4o.input).toBe(2_500n);
    expect(gpt4o.cacheRead).toBe(1_250n); // 0.5x
    expect(findModelPrice("gpt-5")!.cacheRead * 10n).toBe(findModelPrice("gpt-5")!.input); // 0.1x
  });

  it("prices a cached-heavy gpt-5 call correctly end to end", () => {
    const usage = parseOpenAiUsage({
      prompt_tokens: 1_000_000,
      completion_tokens: 100_000,
      prompt_tokens_details: { cached_tokens: 900_000 },
    });
    const priced = priceUsage("gpt-5", usage);

    // 100k uncached @ $1.25 = $0.125
    // 900k cached   @ $0.125 = $0.1125
    // 100k output   @ $10.00 = $1.00
    expect(priced.cost.total).toBe(usd("1.2375"));
  });

  it("does not confuse an OpenAI model id with an Anthropic one", () => {
    expect(findModelPrice("gpt-4o-mini")!.provider).toBe("openai");
    expect(findModelPrice("claude-opus-5")!.provider).toBe("anthropic");
    expect(findModelPrice("gpt-6")).toBeUndefined();
  });

  it("resolves dated OpenAI snapshots to their base model", () => {
    expect(findModelPrice("gpt-4o-2024-08-06")?.id).toBe("gpt-4o");
    // Longest-prefix wins, so the mini variant is not swallowed by gpt-4o.
    expect(findModelPrice("gpt-4o-mini-2024-07-18")?.id).toBe("gpt-4o-mini");
  });
});
