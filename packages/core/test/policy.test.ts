import { describe, expect, it } from "vitest";
import { usd } from "../src/money.js";
import {
  evaluatePolicies,
  type Policy,
  type RequestContext,
  type SpendSnapshot,
} from "../src/policy.js";

const context: RequestContext = {
  agentId: "support-triage",
  department: "Customer Support",
  model: "claude-opus-5",
  maxOutputTokens: 4_096,
};

const noSpend: SpendSnapshot = { day: 0n, month: 0n };

function policy(overrides: Partial<Policy> & Pick<Policy, "rule">): Policy {
  return {
    id: "p1",
    name: "test policy",
    scope: { kind: "tenant" },
    action: "block",
    enabled: true,
    ...overrides,
  };
}

describe("budget rules", () => {
  const monthlyCap = policy({
    name: "monthly cap",
    rule: { kind: "budget", window: "month", limit: usd("100.00") },
  });

  it("allows a request below the cap", () => {
    const decision = evaluatePolicies([monthlyCap], context, { day: 0n, month: usd("99.99") });
    expect(decision.allowed).toBe(true);
    expect(decision.violations).toHaveLength(0);
  });

  it("blocks once the cap is reached", () => {
    const decision = evaluatePolicies([monthlyCap], context, { day: 0n, month: usd("100.00") });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy?.reason).toMatch(/100% of the \$100.00 monthly budget/);
  });

  it("fires early at a fractional threshold, without blocking", () => {
    const warnAt80 = policy({
      id: "p2",
      name: "80% warning",
      action: "warn",
      rule: { kind: "budget", window: "month", limit: usd("100.00"), threshold: 0.8 },
    });

    const decision = evaluatePolicies([warnAt80], context, { day: 0n, month: usd("85.00") });
    expect(decision.allowed).toBe(true);
    expect(decision.violations[0]?.action).toBe("warn");
    expect(decision.violations[0]?.reason).toMatch(/85% of the \$100.00 monthly budget/);
  });

  it("reads the window the rule names", () => {
    const dailyCap = policy({ rule: { kind: "budget", window: "day", limit: usd("10.00") } });
    const spend: SpendSnapshot = { day: usd("11.00"), month: usd("11.00") };
    expect(evaluatePolicies([dailyCap], context, spend).allowed).toBe(false);
    expect(evaluatePolicies([monthlyCap], context, spend).allowed).toBe(true);
  });

  it("rejects an out-of-range threshold", () => {
    const bad = policy({ rule: { kind: "budget", window: "day", limit: usd("1"), threshold: 0 } });
    expect(() => evaluatePolicies([bad], context, noSpend)).toThrow(/threshold must be/);
  });
});

describe("model rules", () => {
  it("blocks a model that is off the allowlist", () => {
    const allowlist = policy({
      rule: { kind: "model-allowlist", models: ["claude-haiku-4-5", "claude-sonnet-5"] },
    });
    const decision = evaluatePolicies([allowlist], context, noSpend);
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy?.reason).toMatch(/claude-opus-5 is not on the allowlist/);
  });

  it("permits a model that is on the allowlist", () => {
    const allowlist = policy({ rule: { kind: "model-allowlist", models: ["claude-opus-5"] } });
    expect(evaluatePolicies([allowlist], context, noSpend).allowed).toBe(true);
  });

  it("blocks a denied model", () => {
    const denylist = policy({ rule: { kind: "model-denylist", models: ["claude-opus-5"] } });
    expect(evaluatePolicies([denylist], context, noSpend).allowed).toBe(false);
  });
});

describe("max-output-tokens rule", () => {
  it("caps runaway completions", () => {
    const cap = policy({ rule: { kind: "max-output-tokens", limit: 1_024 } });
    expect(evaluatePolicies([cap], context, noSpend).allowed).toBe(false);
    expect(evaluatePolicies([cap], { ...context, maxOutputTokens: 512 }, noSpend).allowed).toBe(
      true,
    );
  });
});

describe("scoped budget resolution", () => {
  it("compares each budget against spend measured over its own scope", () => {
    const tenantCap = policy({
      id: "tenant-cap",
      name: "tenant cap",
      scope: { kind: "tenant" },
      rule: { kind: "budget", window: "month", limit: usd("1000.00") },
    });
    const agentCap = policy({
      id: "agent-cap",
      name: "agent cap",
      scope: { kind: "agent", agentId: "support-triage" },
      rule: { kind: "budget", window: "month", limit: usd("50.00") },
    });

    // The tenant has spent $900 in total; this one agent only $60 of it.
    const decision = evaluatePolicies([tenantCap, agentCap], context, (scope) =>
      scope.kind === "tenant"
        ? { day: 0n, month: usd("900.00") }
        : { day: 0n, month: usd("60.00") },
    );

    // Tenant cap ($1000) is untouched; the agent's own $50 cap is blown.
    expect(decision.allowed).toBe(false);
    expect(decision.violations).toHaveLength(1);
    expect(decision.blockedBy?.policyId).toBe("agent-cap");
  });

  it("does not consult the resolver for rules that ignore spend", () => {
    let calls = 0;
    const p = policy({ rule: { kind: "model-denylist", models: ["claude-opus-5"] } });

    evaluatePolicies([p], context, () => {
      calls += 1;
      return noSpend;
    });
    expect(calls).toBe(0);
  });
});

describe("scope matching", () => {
  const rule = { kind: "model-denylist", models: ["claude-opus-5"] } as const;

  it("applies a tenant policy to every agent", () => {
    const p = policy({ scope: { kind: "tenant" }, rule });
    expect(evaluatePolicies([p], context, noSpend).allowed).toBe(false);
  });

  it("applies a department policy only within that department", () => {
    const p = policy({ scope: { kind: "department", department: "Customer Support" }, rule });
    expect(evaluatePolicies([p], context, noSpend).allowed).toBe(false);
    expect(evaluatePolicies([p], { ...context, department: "Legal" }, noSpend).allowed).toBe(true);
  });

  it("applies an agent policy only to that agent", () => {
    const p = policy({ scope: { kind: "agent", agentId: "support-triage" }, rule });
    expect(evaluatePolicies([p], context, noSpend).allowed).toBe(false);
    expect(evaluatePolicies([p], { ...context, agentId: "other" }, noSpend).allowed).toBe(true);
  });
});

describe("evaluation semantics", () => {
  it("ignores disabled policies", () => {
    const p = policy({ enabled: false, rule: { kind: "max-output-tokens", limit: 1 } });
    expect(evaluatePolicies([p], context, noSpend).allowed).toBe(true);
  });

  it("monitor records a violation without blocking", () => {
    const p = policy({ action: "monitor", rule: { kind: "max-output-tokens", limit: 1 } });
    const decision = evaluatePolicies([p], context, noSpend);
    expect(decision.allowed).toBe(true);
    expect(decision.violations).toHaveLength(1);
    expect(decision.violations[0]?.action).toBe("monitor");
  });

  it("collects every violation, not just the first blocking one", () => {
    const decision = evaluatePolicies(
      [
        policy({ id: "a", action: "warn", rule: { kind: "max-output-tokens", limit: 1 } }),
        policy({ id: "b", action: "block", rule: { kind: "model-denylist", models: [context.model] } }),
        policy({ id: "c", action: "monitor", rule: { kind: "budget", window: "day", limit: 0n } }),
      ],
      context,
      noSpend,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.violations).toHaveLength(3);
    expect(decision.blockedBy?.policyId).toBe("b");
  });

  it("allows everything when no policy is configured", () => {
    expect(evaluatePolicies([], context, noSpend).allowed).toBe(true);
  });
});

describe("soft fallback", () => {
  const overBudget: SpendSnapshot = { day: usd("500.00"), month: usd("500.00") };

  function cap(overrides: Partial<Policy> = {}, fallbackModel = "claude-haiku-4-5"): Policy {
    return policy({
      id: "cap",
      name: "monthly cap",
      action: "block",
      rule: { kind: "budget", window: "month", limit: usd("100.00"), fallbackModel },
      ...overrides,
    });
  }

  it("downgrades instead of blocking when the budget is blown", () => {
    const decision = evaluatePolicies([cap()], context, overBudget);

    expect(decision.allowed).toBe(true);
    expect(decision.blockedBy).toBeUndefined();
    expect(decision.route).toMatchObject({
      fromModel: "claude-opus-5",
      toModel: "claude-haiku-4-5",
      applied: true,
      fallback: true,
    });
  });

  it("still records the violation, so the feed shows why the model changed", () => {
    const decision = evaluatePolicies([cap()], context, overBudget);

    expect(decision.violations).toHaveLength(1);
    expect(decision.violations[0]?.action).toBe("warn");
    expect(decision.violations[0]?.reason).toContain("500% of the $100.00 monthly budget");
    // The downgrade itself is reported on the route decision, not folded into
    // the budget's reason — the two are recorded as separate feed entries.
    expect(decision.route?.reason).toContain("downgraded from claude-opus-5");
  });

  it("leaves an under-budget call completely alone", () => {
    const decision = evaluatePolicies([cap()], context, { day: 0n, month: usd("99.99") });

    expect(decision.allowed).toBe(true);
    expect(decision.violations).toHaveLength(0);
    expect(decision.route).toBeUndefined();
  });

  it("monitor is a genuine dry run: recorded, not rewritten", () => {
    const decision = evaluatePolicies([cap({ action: "monitor" })], context, overBudget);

    expect(decision.allowed).toBe(true);
    expect(decision.route?.applied).toBe(false);
    expect(decision.route?.fallback).toBe(true);
    expect(decision.violations[0]?.action).toBe("monitor");
    expect(decision.route?.reason).toContain("dry run");
  });

  it("blocks after all when the downgrade cannot be made", () => {
    // Traffic is already on the fallback model, so there is nothing cheaper
    // left to give and the cap the customer set still has to mean something.
    const decision = evaluatePolicies(
      [cap()],
      { ...context, model: "claude-haiku-4-5" },
      overBudget,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy?.policyId).toBe("cap");
    expect(decision.route).toBeUndefined();
  });

  it("never blocks on a warn rule, even with no usable downgrade", () => {
    const decision = evaluatePolicies(
      [cap({ action: "warn" })],
      { ...context, model: "claude-haiku-4-5" },
      overBudget,
    );

    expect(decision.allowed).toBe(true);
    expect(decision.route).toBeUndefined();
    expect(decision.violations[0]?.action).toBe("warn");
  });

  it("refuses to downgrade across providers", () => {
    const decision = evaluatePolicies([cap({}, "gpt-5")], context, overBudget);

    expect(decision.allowed).toBe(false);
    expect(decision.route).toBeUndefined();
  });

  it("refuses to downgrade to a model it cannot price", () => {
    const decision = evaluatePolicies([cap({}, "claude-imaginary-9")], context, overBudget);

    expect(decision.allowed).toBe(false);
    expect(decision.route).toBeUndefined();
  });

  it("outranks a standing route rule", () => {
    const routeRule = policy({
      id: "standing",
      action: "warn",
      rule: { kind: "route", toModel: "claude-sonnet-5" },
    });

    // Rule order should not matter: the emergency measure wins either way.
    for (const policies of [[routeRule, cap()], [cap(), routeRule]]) {
      const decision = evaluatePolicies(policies, context, overBudget);
      expect(decision.route?.toModel).toBe("claude-haiku-4-5");
      expect(decision.route?.fallback).toBe(true);
    }
  });

  it("is still overridden by a separate block rule", () => {
    const denied = policy({
      id: "denied",
      action: "block",
      rule: { kind: "model-denylist", models: ["claude-opus-5"] },
    });
    const decision = evaluatePolicies([cap(), denied], context, overBudget);

    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy?.policyId).toBe("denied");
    // A refused call is not downgraded — it is not going anywhere.
    expect(decision.route).toBeUndefined();
  });

  it("takes the first fired budget when two caps both offer a fallback", () => {
    const decision = evaluatePolicies(
      [
        cap({ id: "first" }, "claude-sonnet-5"),
        cap({ id: "second" }, "claude-haiku-4-5"),
      ],
      context,
      overBudget,
    );

    expect(decision.route?.toModel).toBe("claude-sonnet-5");
    expect(decision.violations).toHaveLength(2);
  });
});
