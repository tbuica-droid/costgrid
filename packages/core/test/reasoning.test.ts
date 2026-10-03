import { describe, expect, it } from "vitest";
import {
  anthropicReasoningOf,
  describeReasoning,
  evaluatePolicies,
  findModelPrice,
  openAiReasoningOf,
  parseOpenAiReasoningTokens,
  type Policy,
  type RequestContext,
  toUsdString,
  ZERO_SPEND,
} from "../src/index.js";

const CONTEXT: RequestContext = {
  agentId: "support-bot",
  department: "Support",
  model: "claude-opus-5-5",
  maxOutputTokens: 4096,
};

const policy = (rule: Policy["rule"], scope: Policy["scope"] = { kind: "tenant" }): Policy => ({
  id: "p1",
  name: "test rule",
  scope,
  rule,
  action: "block",
  enabled: true,
});

describe("reading what a request asks the model to think", () => {
  it("reads Anthropic effort and the older fixed thinking budget", () => {
    expect(anthropicReasoningOf({ output_config: { effort: "xhigh" }, thinking: { type: "adaptive" } })).toEqual({
      effort: "xhigh",
      thinking: true,
    });
    expect(anthropicReasoningOf({ thinking: { type: "enabled", budget_tokens: 8000 } })).toEqual({
      thinking: true,
      budgetTokens: 8000,
    });
  });

  it("says nothing, rather than zero, when the request says nothing", () => {
    expect(anthropicReasoningOf({ model: "claude-opus-5-5", messages: [] })).toBeUndefined();
    expect(openAiReasoningOf({ model: "gpt-6-sol" })).toBeUndefined();
    expect(anthropicReasoningOf({ output_config: { effort: "enormous" } })).toBeUndefined();
  });

  it("reads OpenAI effort from Chat Completions and from the Responses API", () => {
    expect(openAiReasoningOf({ reasoning_effort: "high" })).toEqual({ effort: "high", thinking: true });
    expect(openAiReasoningOf({ reasoning: { effort: "minimal" } })).toEqual({ effort: "minimal", thinking: true });
  });

  it("labels the request for the call record", () => {
    expect(describeReasoning({ effort: "high", thinking: true })).toBe("effort:high");
    expect(describeReasoning({ thinking: true, budgetTokens: 8000 })).toBe("budget:8000");
    expect(describeReasoning({ thinking: true })).toBe("thinking");
    expect(describeReasoning(undefined)).toBeUndefined();
  });

  it("reads reasoning tokens only where the provider reports them", () => {
    expect(parseOpenAiReasoningTokens({ completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } })).toBe(700);
    expect(parseOpenAiReasoningTokens({ output_tokens: 900, output_tokens_details: { reasoning_tokens: 12 } })).toBe(12);
    // Not reported is not zero.
    expect(parseOpenAiReasoningTokens({ completion_tokens: 900 })).toBeUndefined();
    expect(parseOpenAiReasoningTokens({ completion_tokens_details: { reasoning_tokens: -1 } })).toBeUndefined();
  });
});

describe("the stop rule", () => {
  it("refuses every call in its scope and nothing outside it", () => {
    const stop = policy({ kind: "stop" }, { kind: "agent", agentId: "support-bot" });
    const decision = evaluatePolicies([stop], CONTEXT, ZERO_SPEND);
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy?.reason).toMatch(/stopped by an operator/);

    const other = evaluatePolicies([stop], { ...CONTEXT, agentId: "billing-bot" }, ZERO_SPEND);
    expect(other.allowed).toBe(true);
  });

  it("is a no-op once disabled, which is what resuming does", () => {
    const stop = { ...policy({ kind: "stop" }), enabled: false };
    expect(evaluatePolicies([stop], CONTEXT, ZERO_SPEND).allowed).toBe(true);
  });
});

describe("the reasoning cap", () => {
  const cap = policy({ kind: "max-reasoning", effort: "medium", budgetTokens: 4000 });

  it("refuses a request asking for more effort than allowed", () => {
    const d = evaluatePolicies([cap], { ...CONTEXT, reasoning: { effort: "xhigh", thinking: true } }, ZERO_SPEND);
    expect(d.allowed).toBe(false);
    expect(d.blockedBy?.reason).toBe("reasoning effort xhigh is above the cap of medium");
  });

  it("refuses a thinking budget over the cap", () => {
    const d = evaluatePolicies([cap], { ...CONTEXT, reasoning: { thinking: true, budgetTokens: 16000 } }, ZERO_SPEND);
    expect(d.blockedBy?.reason).toBe("thinking budget 16000 exceeds the cap of 4000");
  });

  it("allows requests at or under the cap", () => {
    expect(evaluatePolicies([cap], { ...CONTEXT, reasoning: { effort: "medium" } }, ZERO_SPEND).allowed).toBe(true);
    expect(evaluatePolicies([cap], { ...CONTEXT, reasoning: { effort: "low" } }, ZERO_SPEND).allowed).toBe(true);
  });

  it("does not judge a request that names no reasoning, rather than guessing the provider default", () => {
    expect(evaluatePolicies([cap], CONTEXT, ZERO_SPEND).allowed).toBe(true);
  });
});

describe("price table corrections found by the live check on 2026-10-03", () => {
  it("prices Claude Opus 5.5 on its own row, not as Opus 5", () => {
    const opus55 = findModelPrice("claude-opus-5-5")!;
    expect(opus55.id).toBe("claude-opus-5-5");
    expect(toUsdString(opus55.input * 1_000_000n, 2)).toBe("4.00");
    expect(toUsdString(opus55.output * 1_000_000n, 2)).toBe("20.00");
    expect(toUsdString(opus55.cacheRead * 1_000_000n, 2)).toBe("0.20");
    expect(toUsdString(opus55.fastOutput! * 1_000_000n, 2)).toBe("40.00");
  });

  it("knows the three OpenAI models that were being recorded as unpriced", () => {
    for (const id of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) expect(findModelPrice(id)?.id).toBe(id);
    expect(toUsdString(findModelPrice("gpt-6-luna")!.input * 1_000_000n, 2)).toBe("0.10");
  });
});
