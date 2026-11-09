import { describe, expect, it } from "vitest";
import {
  adjustmentRulesFor,
  applyAdjustments,
  effortsAccepted,
  fitEffort,
  oneLevelBelow,
  usesCacheControl,
  type Policy,
  type RequestContext,
} from "../src/index.js";

const context: RequestContext = {
  agentId: "support",
  department: "cx",
  model: "claude-sonnet-4-6",
  maxOutputTokens: 1024,
};

function policy(rule: Policy["rule"], over: Partial<Policy> = {}): Policy {
  return {
    id: `p-${rule.kind}`,
    name: rule.kind,
    scope: { kind: "agent", agentId: "support" },
    rule,
    action: "warn",
    enabled: true,
    ...over,
  };
}

describe("adjustmentRulesFor", () => {
  it("takes the first enabled rule of each kind in scope", () => {
    const first = policy({ kind: "lower-reasoning", effort: "low" }, { id: "a" });
    const second = policy({ kind: "lower-reasoning", effort: "medium" }, { id: "b" });
    const cache = policy({ kind: "add-cache" });
    const off = policy({ kind: "add-cache" }, { id: "off", enabled: false });
    const elsewhere = policy({ kind: "add-cache" }, { id: "x", scope: { kind: "agent", agentId: "sales" } });
    const budget = policy({ kind: "budget", window: "day", limit: 1n });
    const rules = adjustmentRulesFor([off, elsewhere, first, budget, second, cache], context);
    expect(rules.map((r) => r.id)).toEqual(["a", "p-add-cache"]);
  });
});

describe("lower-reasoning", () => {
  it("lowers a Claude effort above the target and leaves the input untouched", () => {
    const body = { model: "m", output_config: { effort: "high", format: "x" } };
    const { body: out, adjustments } = applyAdjustments(
      [policy({ kind: "lower-reasoning", effort: "low" })],
      "anthropic",
      body,
    );
    expect(out).toEqual({ model: "m", output_config: { effort: "low", format: "x" } });
    expect(body.output_config.effort).toBe("high");
    expect(adjustments).toEqual([
      { policyId: "p-lower-reasoning", policyName: "lower-reasoning", kind: "lower-reasoning", applied: true, change: "effort:high->low" },
    ]);
  });

  it("never raises effort, and never adds it where the request named none", () => {
    const rules = [policy({ kind: "lower-reasoning", effort: "medium" })];
    expect(applyAdjustments(rules, "anthropic", { output_config: { effort: "low" } }).adjustments).toEqual([]);
    expect(applyAdjustments(rules, "anthropic", { model: "m" }).adjustments).toEqual([]);
    expect(applyAdjustments(rules, "openai", { model: "m" }).adjustments).toEqual([]);
  });

  it("clamps a target Claude does not offer to its lowest level", () => {
    const { body } = applyAdjustments(
      [policy({ kind: "lower-reasoning", effort: "minimal" })],
      "anthropic",
      { output_config: { effort: "medium" } },
    );
    expect(body).toEqual({ output_config: { effort: "low" } });
  });

  it("lowers both OpenAI spellings", () => {
    const rules = [policy({ kind: "lower-reasoning", effort: "minimal" })];
    expect(applyAdjustments(rules, "openai", { model: "gpt-5", reasoning_effort: "high" }).body).toEqual({
      model: "gpt-5",
      reasoning_effort: "minimal",
    });
    expect(
      applyAdjustments(rules, "openai", { model: "gpt-5-mini", reasoning: { effort: "medium", summary: "auto" } }).body,
    ).toEqual({ model: "gpt-5-mini", reasoning: { effort: "minimal", summary: "auto" } });
  });

  it("never lowers to a level the model rejects", () => {
    const rules = [policy({ kind: "lower-reasoning", effort: "minimal" })];
    // o3 has no `minimal`: the lowest it takes is `low`.
    const o3 = applyAdjustments(rules, "openai", { model: "o3", reasoning_effort: "high" });
    expect(o3.body).toEqual({ model: "o3", reasoning_effort: "low" });
    expect(o3.adjustments[0]!.change).toBe("effort:high->low");
    // Already at its lowest: nothing is changed, rather than sending `minimal`.
    expect(applyAdjustments(rules, "openai", { model: "o4-mini", reasoning_effort: "low" }).adjustments).toEqual([]);
    // A model passed in (Bedrock, Vertex, a routed call) wins over the body.
    expect(applyAdjustments(rules, "openai", { reasoning_effort: "high" }, "gpt-5-nano").body).toEqual({
      reasoning_effort: "minimal",
    });
    // A model CostGrid does not know gets only the levels every model takes.
    expect(applyAdjustments(rules, "openai", { model: "gpt-7", reasoning_effort: "medium" }).body).toEqual({
      model: "gpt-7",
      reasoning_effort: "low",
    });
    // Pro models run at high only.
    expect(applyAdjustments(rules, "openai", { model: "gpt-5-pro", reasoning_effort: "high" }).adjustments).toEqual([]);
  });

  it("caps a thinking budget, never below Anthropic's minimum", () => {
    const rules = [policy({ kind: "lower-reasoning", budgetTokens: 500 })];
    const { body, adjustments } = applyAdjustments(rules, "anthropic", {
      thinking: { type: "enabled", budget_tokens: 16000 },
    });
    expect(body).toEqual({ thinking: { type: "enabled", budget_tokens: 1024 } });
    expect(adjustments[0]!.change).toBe("budget:16000->1024");
    expect(
      applyAdjustments(rules, "anthropic", { thinking: { type: "enabled", budget_tokens: 1000 } }).adjustments,
    ).toEqual([]);
  });

  it("records a dry run without changing the body", () => {
    const body = { output_config: { effort: "max" } };
    const result = applyAdjustments(
      [policy({ kind: "lower-reasoning", effort: "high" }, { action: "monitor" })],
      "anthropic",
      body,
    );
    expect(result.body).toBe(body);
    expect(result.adjustments[0]).toMatchObject({ applied: false, change: "effort:max->high" });
  });
});

describe("add-cache", () => {
  const rules = [policy({ kind: "add-cache" })];
  const mark = { type: "ephemeral" };

  it("marks the last tool and turns a string system prompt into a marked block", () => {
    const body = {
      system: "You are a careful support agent.",
      tools: [{ name: "a" }, { name: "b" }],
      messages: [{ role: "user", content: "hi" }],
    };
    const { body: out, adjustments } = applyAdjustments(rules, "anthropic", body);
    expect(out).toEqual({
      system: [{ type: "text", text: "You are a careful support agent.", cache_control: mark }],
      tools: [{ name: "a" }, { name: "b", cache_control: mark }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(adjustments[0]!.change).toBe("cache:tools,system");
    expect(body.tools[1]).toEqual({ name: "b" });
  });

  it("marks the last block of a system array", () => {
    const { body } = applyAdjustments(rules, "anthropic", {
      system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
    });
    expect(body).toEqual({ system: [{ type: "text", text: "a" }, { type: "text", text: "b", cache_control: mark }] });
  });

  it("leaves a request alone when it already uses caching anywhere", () => {
    const inMessage = {
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: mark }] }],
    };
    expect(usesCacheControl(inMessage)).toBe(true);
    expect(applyAdjustments(rules, "anthropic", inMessage).adjustments).toEqual([]);
  });

  it("does nothing for OpenAI, or with nothing to mark", () => {
    expect(applyAdjustments(rules, "openai", { messages: [] }).adjustments).toEqual([]);
    expect(applyAdjustments(rules, "anthropic", { system: "", messages: [] }).adjustments).toEqual([]);
  });
});

describe("oneLevelBelow", () => {
  it("steps down within what the format accepts", () => {
    expect(oneLevelBelow("high", "anthropic")).toBe("medium");
    expect(oneLevelBelow("low", "anthropic")).toBeUndefined();
    expect(oneLevelBelow("low", "openai", "gpt-5")).toBe("minimal");
    expect(oneLevelBelow("minimal", "openai", "gpt-5")).toBeUndefined();
    expect(oneLevelBelow("low", "openai", "o3")).toBeUndefined();
    expect(oneLevelBelow("medium", "openai", "o4-mini-2025-04-16")).toBe("low");
    expect(oneLevelBelow("high", "openai", "o3-pro")).toBeUndefined();
  });
});

describe("effort levels, as the live APIs answered on 8 November 2026", () => {
  it("knows which Claude models take which levels, and which take none", () => {
    expect(effortsAccepted("claude-opus-5-5", "anthropic")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsAccepted("claude-opus-4-6", "anthropic")).toEqual(["low", "medium", "high", "max"]);
    expect(effortsAccepted("claude-sonnet-4-6", "anthropic")).toEqual(["low", "medium", "high", "max"]);
    expect(effortsAccepted("claude-opus-4-5", "anthropic")).toEqual(["low", "medium", "high"]);
    expect(effortsAccepted("claude-haiku-4-5", "anthropic")).toEqual([]);
    expect(effortsAccepted("claude-sonnet-4-5-20250929", "anthropic")).toEqual([]);
    expect(effortsAccepted("gpt-4.1-mini", "openai")).toEqual([]);
    // max on Opus 4.6 steps down to high, not to the xhigh it refuses.
    expect(oneLevelBelow("max", "anthropic", "claude-opus-4-6")).toBe("high");
  });

  it("fits a moved call's effort to its new model, or drops it", () => {
    const claude = { model: "claude-haiku-4-5", output_config: { effort: "high" }, messages: [] };
    expect(fitEffort("anthropic", "claude-haiku-4-5", claude)).toEqual({ model: "claude-haiku-4-5", messages: [] });
    expect(fitEffort("anthropic", "claude-opus-4-6", { output_config: { effort: "xhigh", format: "x" } })).toEqual({
      output_config: { effort: "high", format: "x" },
    });
    const kept = { output_config: { effort: "high" } };
    expect(fitEffort("anthropic", "claude-sonnet-5-5", kept)).toBe(kept);
    expect(fitEffort("openai", "gpt-4o-mini", { reasoning_effort: "high", messages: [] })).toEqual({ messages: [] });
    expect(fitEffort("openai", "o3", { reasoning_effort: "minimal" })).toEqual({ reasoning_effort: "low" });
    expect(fitEffort("openai", "gpt-5-pro", { reasoning: { effort: "low" } })).toEqual({ reasoning: { effort: "high" } });
  });
});
