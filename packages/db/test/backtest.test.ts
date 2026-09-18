import { priceUsage, usd, ZERO_USAGE } from "@costgrid/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Advisor } from "../src/advise.js";
import { Backtester } from "../src/backtest.js";
import { openDatabase } from "../src/database.js";
import { CostGridRepository } from "../src/repositories.js";

const DAY = 86_400_000;
/** Fixed instant so day/month bucketing is deterministic: 2026-03-10T00:00:00Z. */
const T0 = Date.UTC(2026, 2, 10);

describe("backtesting a rule against traffic that already happened", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let backtester: Backtester;
  let seq = 0;

  const record = (over: {
    model?: string;
    agent?: string;
    at?: number;
    department?: string;
    outputTokens?: number;
    inputTokens?: number;
    runId?: string;
    runDeclared?: boolean;
    stopReason?: string;
    outcome?: "ok" | "blocked" | "error";
  }) => {
    const model = over.model ?? "claude-opus-5";
    const usage = {
      ...ZERO_USAGE,
      inputTokens: over.inputTokens ?? 10_000,
      outputTokens: over.outputTokens ?? 2_000,
    };
    const priced = priceUsage(model, usage);
    const id = `c${(seq += 1)}`;
    repository.recordCall({
      id,
      tenantId: "t1",
      agentId: over.agent ?? "worker",
      department: over.department ?? "Eng",
      provider: "anthropic",
      model,
      startedAt: over.at ?? T0,
      durationMs: 10,
      streamed: false,
      usage,
      cost: priced.cost,
      priced: priced.priced,
      outcome: over.outcome ?? "ok",
      runId: over.runId ?? id,
      runDeclared: over.runDeclared ?? false,
      ...(over.stopReason !== undefined ? { stopReason: over.stopReason } : {}),
    });
  };

  const window = () => ({ from: T0 - 30 * DAY, to: T0 + 30 * DAY });

  beforeEach(() => {
    seq = 0;
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    backtester = new Backtester(db);
    repository.createTenant("Acme", "t1");
  });

  afterEach(() => db.close());

  // ------------------------------------------------------------------ route

  it("prices a route rule against the tokens that were actually used", () => {
    for (let i = 0; i < 5; i += 1) record({ model: "claude-opus-5", at: T0 + i });

    const result = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "route", from: ["claude-opus-5"], toModel: "claude-haiku-4-5" },
      window(),
    );

    expect(result.callsAffected).toBe(5);
    expect(result.basis).toBe("estimated");
    expect(result.amount).toBeGreaterThan(0n);
    // The saving cannot exceed what was spent: you cannot save more than the bill.
    expect(result.amount!).toBeLessThan(result.spendInScope);
    expect(result.caveat).toContain("estimate");
  });

  it("ignores calls the rule's --from does not name", () => {
    record({ model: "claude-opus-5" });
    record({ model: "claude-sonnet-5" });

    const result = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "route", from: ["claude-opus-5"], toModel: "claude-haiku-4-5" },
      window(),
    );
    expect(result.callsInScope).toBe(2);
    expect(result.callsAffected).toBe(1);
  });

  /*
   * The live evaluator refuses a substitution it cannot make. A backtest that
   * quoted a saving from one would be advertising money the gateway would
   * never actually go and get.
   */
  it("quotes nothing for a substitution the gateway would refuse", () => {
    record({ model: "claude-haiku-4-5" });

    const result = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "route", toModel: "claude-haiku-4-5" },
      window(),
    );
    expect(result.callsAffected).toBe(0);
    expect(result.amount).toBeUndefined();
  });

  it("scopes to one agent when the rule does", () => {
    record({ agent: "a" });
    record({ agent: "b" });

    const result = backtester.run(
      "t1",
      { kind: "agent", agentId: "a" },
      { kind: "route", toModel: "claude-haiku-4-5" },
      window(),
    );
    expect(result.callsInScope).toBe(1);
  });

  // ------------------------------------------------------------- allowlists

  it("reports a block as spend avoided, not as money saved", () => {
    record({ model: "claude-opus-5" });
    record({ model: "claude-opus-5" });
    record({ model: "claude-haiku-4-5" });

    const result = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "model-allowlist", models: ["claude-haiku-4-5"] },
      window(),
    );

    expect(result.callsAffected).toBe(2);
    expect(result.basis).toBe("avoided");
    // The wording is the feature: these calls would have failed, not succeeded
    // more cheaply.
    expect(result.caveat).toContain("not money saved");
    expect(result.caveat).toContain("retried");
  });

  // ---------------------------------------------------------------- budgets

  it("walks a budget in time order and fires only after the cap", () => {
    // Five calls on one UTC day; the cap sits partway through.
    for (let i = 0; i < 5; i += 1) record({ at: T0 + i * 1000 });

    const one = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "budget", window: "day", limit: usd("999999.00") },
      window(),
    );
    expect(one.callsAffected).toBe(0);
    expect(one.firstFireAt).toBeUndefined();

    const tight = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "budget", window: "day", limit: 1n },
      window(),
    );
    // The first call takes the running total past a 1-nanodollar cap, so
    // everything after it is refused — but the first one itself is not.
    expect(tight.callsAffected).toBe(4);
    expect(tight.firstFireAt).toBe(T0 + 1000);
  });

  it("resets the running total when the window rolls over", () => {
    record({ at: T0 });
    record({ at: T0 + 1000 });
    // Next UTC day: the cap starts again from zero.
    record({ at: T0 + DAY });
    record({ at: T0 + DAY + 1000 });

    const result = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "budget", window: "day", limit: 1n },
      window(),
    );
    // One survivor per day, not one survivor overall.
    expect(result.callsAffected).toBe(2);
  });

  // ------------------------------------------------------------------- runs

  it("counts the calls a run made past its step cap", () => {
    for (let i = 0; i < 6; i += 1) {
      record({ at: T0 + i * 1000, runId: "run-a", runDeclared: true });
    }

    const result = backtester.run("t1", { kind: "tenant" }, { kind: "run-steps", limit: 3 }, window());
    expect(result.callsAffected).toBe(3);
  });

  /*
   * The invariant from stage 1a, held here too: a run CostGrid invented has
   * exactly one call, so a step cap can never fire on it. A backtest that
   * counted them would advertise protection the live rule does not provide.
   */
  it("never fires on runs the caller did not declare", () => {
    for (let i = 0; i < 6; i += 1) record({ at: T0 + i * 1000, runDeclared: false });

    const result = backtester.run("t1", { kind: "tenant" }, { kind: "run-steps", limit: 1 }, window());
    expect(result.callsAffected).toBe(0);
  });

  it("stops a run once it passes its ceiling", () => {
    for (let i = 0; i < 5; i += 1) {
      record({ at: T0 + i * 1000, runId: "run-a", runDeclared: true });
    }

    const result = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "run-budget", limit: 1n },
      window(),
    );
    expect(result.callsAffected).toBe(4);
  });

  // --------------------------------------------------------------- excluded

  it("ignores calls that were blocked or errored", () => {
    record({ outcome: "blocked" });
    record({ outcome: "error" });
    record({ outcome: "ok" });

    const result = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "route", toModel: "claude-haiku-4-5" },
      window(),
    );
    // A call that never reached the provider cannot be re-routed, and counting
    // it would double-count a prevention another rule already made.
    expect(result.callsInScope).toBe(1);
  });

  it("says so rather than guessing for a rule it cannot replay", () => {
    record({});
    const result = backtester.run(
      "t1",
      { kind: "tenant" },
      { kind: "tool-denylist", tools: ["refund_customer"] },
      window(),
    );
    expect(result.callsAffected).toBe(0);
    expect(result.caveat).toContain("cannot be replayed");
    expect(result.caveat).toContain("monitor");
  });
});

describe("advising from a fleet's own traffic", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let advisor: Advisor;
  let seq = 0;

  const record = (over: {
    model?: string;
    agent?: string;
    at?: number;
    department?: string;
    outputTokens?: number;
    runId?: string;
    runDeclared?: boolean;
    stopReason?: string;
  }) => {
    const model = over.model ?? "claude-opus-5";
    const usage = { ...ZERO_USAGE, inputTokens: 40_000, outputTokens: over.outputTokens ?? 200 };
    const priced = priceUsage(model, usage);
    const id = `c${(seq += 1)}`;
    repository.recordCall({
      id,
      tenantId: "t1",
      agentId: over.agent ?? "classifier",
      department: over.department ?? "Support",
      provider: "anthropic",
      model,
      startedAt: over.at ?? T0,
      durationMs: 10,
      streamed: false,
      usage,
      cost: priced.cost,
      priced: priced.priced,
      outcome: "ok",
      runId: over.runId ?? id,
      runDeclared: over.runDeclared ?? false,
      ...(over.stopReason !== undefined ? { stopReason: over.stopReason } : {}),
    });
  };

  const window = () => ({ from: T0 - 30 * DAY, to: T0 + 30 * DAY });

  beforeEach(() => {
    seq = 0;
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    advisor = new Advisor(db);
    repository.createTenant("Acme", "t1");
  });

  afterEach(() => db.close());

  it("proposes nothing for a fleet with nothing wrong", () => {
    // Cheap model, short answers, spread out, well under every threshold.
    for (let i = 0; i < 30; i += 1) {
      record({ model: "claude-haiku-4-5", at: T0 + i * 3_600_000, outputTokens: 100 });
    }
    expect(advisor.proposals("t1", window())).toHaveLength(0);
  });

  it("spots an expensive model doing short work, and proves the saving", () => {
    // 40 calls, big prompt, tiny answer, on the most expensive model.
    for (let i = 0; i < 120; i += 1) record({ at: T0 + i * 60_000, outputTokens: 150 });

    const proposals = advisor.proposals("t1", window());
    const route = proposals.find((p) => p.kind === "route-to-cheaper");

    expect(route).toBeDefined();
    expect(route!.command).toContain("policy route agent:classifier");
    // Every proposed rule arrives as a dry run.
    expect(route!.command).toContain("--action monitor");
    expect(route!.backtest?.basis).toBe("estimated");
    expect(route!.backtest?.amount).toBeGreaterThan(0n);
  });

  it("never proposes a rule it could not back with a replay", () => {
    for (let i = 0; i < 120; i += 1) record({ at: T0 + i * 60_000, outputTokens: 150 });

    for (const proposal of advisor.proposals("t1", window())) {
      if (proposal.rule?.kind !== "route") continue;
      expect(proposal.backtest?.amount).toBeGreaterThan(0n);
    }
  });

  it("flags a department with real spend and no cap", () => {
    for (let i = 0; i < 120; i += 1) record({ at: T0 + i * 60_000 });

    const found = advisor.proposals("t1", window()).find((p) => p.kind === "unguarded-spend");
    expect(found).toBeDefined();
    expect(found!.command).toContain("policy budget dept:Support");
  });

  /*
   * A grant that went uncalled across a handful of requests is not an unused
   * capability, it is a handful of requests. Firing here would tell a customer
   * on their first afternoon to remove a tool their agent had not reached yet.
   */
  it("says nothing about unused tools until an agent has real traffic", () => {
    record({});
    repository.recordTools({
      tenantId: "t1",
      callId: "c1",
      runId: "c1",
      agentId: "classifier",
      invoked: [],
      granted: ["refund_customer"],
      at: T0,
    });

    const found = advisor.proposals("t1", window()).find((p) => p.kind === "unused-capability");
    expect(found).toBeUndefined();
  });

  it("spots a big prompt being re-sent with nothing reused", () => {
    // 40k input per call, no cache reads: the shape of a fixed instruction
    // block paid for in full every time.
    for (let i = 0; i < 120; i += 1) record({ at: T0 + i * 60_000 });

    const found = advisor.proposals("t1", window()).find((p) => p.kind === "cache-opportunity");
    expect(found).toBeDefined();
    // How much of that prompt is actually identical is a fact about their
    // code, so no saving is quoted and no rule is proposed.
    expect(found!.command).toBeUndefined();
    expect(found!.intent).toBe("finding");
  });

  it("stays quiet about caps once a tenant-wide budget exists", () => {
    for (let i = 0; i < 120; i += 1) record({ at: T0 + i * 60_000 });
    repository.createPolicy("t1", {
      name: "tenant cap",
      scope: { kind: "tenant" },
      rule: { kind: "budget", window: "month", limit: usd("500.00") },
      action: "block",
      enabled: true,
    });

    const found = advisor.proposals("t1", window()).find((p) => p.kind === "unguarded-spend");
    expect(found).toBeUndefined();
  });

  it("reports truncated answers as waste with no rule to write", () => {
    for (let i = 0; i < 120; i += 1) {
      record({
        at: T0 + i * 60_000,
        outputTokens: 8_000,
        ...(i % 3 === 0 ? { stopReason: "max_tokens" } : {}),
      });
    }

    const found = advisor.proposals("t1", window()).find((p) => p.kind === "truncation-waste");
    expect(found).toBeDefined();
    expect(found!.rule).toBeUndefined();
    // The fix is in their code, and inventing a policy for it would be worse
    // than saying there isn't one.
    expect(found!.command).toBeUndefined();
  });

  it("proposes dropping a tool an agent holds and never uses, and weighs it at nothing", () => {
    for (let i = 0; i < 25; i += 1) record({ at: T0 + i * 60_000 });
    repository.recordTools({
      tenantId: "t1",
      callId: "c1",
      runId: "c1",
      agentId: "classifier",
      invoked: ["search_docs"],
      granted: ["search_docs", "refund_customer"],
      at: T0,
    });

    const found = advisor.proposals("t1", window()).find((p) => p.kind === "unused-capability");
    expect(found).toBeDefined();
    expect(found!.command).toContain("deny-tool agent:classifier refund_customer");
    // A tool that was never called was never billed. Weighting it above a real
    // saving to get it noticed would be the first dishonest number here.
    expect(found!.weight).toBe(0n);
  });

  it("proposes a step cap for an agent with very long runs", () => {
    // One run of 30 steps, repeated, so the agent clears the spend floor.
    for (let run = 0; run < 4; run += 1) {
      for (let i = 0; i < 30; i += 1) {
        record({
          agent: "looper",
          at: T0 + run * 3_600_000 + i * 60_000,
          runId: `loop-${run}`,
          runDeclared: true,
        });
      }
    }

    const found = advisor.proposals("t1", window()).find((p) => p.kind === "long-run");
    expect(found?.rule?.kind).toBe("run-steps");
    expect(found!.command).toContain("policy run-steps agent:looper");
    // Set above the longest run seen, not at it: a cap that fires on the next
    // normal run gets switched off rather than tuned.
    expect((found!.rule as { limit: number }).limit).toBeGreaterThan(30);
  });

  /*
   * Run-level rules cannot fire on traffic with no run id, and a rule that
   * cannot fire must not look like protection. A fleet in that state is told
   * the prerequisite is missing rather than sold a control that would sit
   * there doing nothing.
   */
  it("tells a fleet with no run ids that run rules cannot work yet", () => {
    for (let i = 0; i < 250; i += 1) {
      record({ agent: "worker", at: T0 + i * 60_000, runDeclared: false });
    }

    const found = advisor.proposals("t1", window()).find((p) => p.kind === "no-run-context");
    expect(found).toBeDefined();
    expect(found!.rule).toBeUndefined();
    expect(found!.evidence).toContain("x-costgrid-run");
  });

  it("stays quiet about run coverage once any traffic declares a run", () => {
    for (let i = 0; i < 250; i += 1) {
      record({
        agent: "worker",
        at: T0 + i * 60_000,
        ...(i === 0 ? { runId: "r1", runDeclared: true } : {}),
      });
    }

    const found = advisor.proposals("t1", window()).find((p) => p.kind === "no-run-context");
    expect(found).toBeUndefined();
  });

  /*
   * Ranking everything by "money involved" put two proposals that save nothing
   * above a route rule worth real money, under a heading promising the
   * opposite. A saving and an exposure are different quantities and cannot
   * share a sort order.
   */
  it("puts what saves money above what merely bounds a risk", () => {
    for (let i = 0; i < 120; i += 1) record({ at: T0 + i * 60_000, outputTokens: 150 });

    const proposals = advisor.proposals("t1", window());
    expect(proposals.length).toBeGreaterThan(1);
    expect(proposals[0]!.intent).toBe("saving");

    const rank = { saving: 0, guardrail: 1, finding: 2 } as const;
    for (let i = 1; i < proposals.length; i += 1) {
      const before = proposals[i - 1]!;
      const after = proposals[i]!;
      expect(rank[before.intent]).toBeLessThanOrEqual(rank[after.intent]);
      // And within one intent, most money first.
      if (before.intent === after.intent) {
        expect(before.weight >= after.weight).toBe(true);
      }
    }
  });

  it("marks a proposal that saves nothing as a guardrail, not a saving", () => {
    for (let i = 0; i < 120; i += 1) record({ at: T0 + i * 60_000 });

    const cap = advisor.proposals("t1", window()).find((p) => p.kind === "unguarded-spend");
    expect(cap!.intent).toBe("guardrail");
    // A cap proposed above observed spend should not have fired in the replay —
    // that is the rule being correctly sized, not the proposal being useless.
    expect(cap!.backtest?.callsAffected).toBe(0);
  });
});
