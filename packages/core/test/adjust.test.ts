import { describe, expect, it } from "vitest";
import {
  adjustmentRulesFor,
  applyAdjustments,
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
    expect(applyAdjustments(rules, "openai", { reasoning_effort: "high" }).body).toEqual({ reasoning_effort: "minimal" });
    expect(applyAdjustments(rules, "openai", { reasoning: { effort: "medium", summary: "auto" } }).body).toEqual({
      reasoning: { effort: "minimal", summary: "auto" },
    });
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
    expect(oneLevelBelow("low", "openai")).toBe("minimal");
    expect(oneLevelBelow("minimal", "openai")).toBeUndefined();
  });
});
