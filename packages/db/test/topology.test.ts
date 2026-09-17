import { priceUsage, ZERO_USAGE } from "@costgrid/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Analytics } from "../src/analytics.js";
import { openDatabase } from "../src/database.js";
import { CostGridRepository } from "../src/repositories.js";

describe("topology", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;
  let n = 0;

  const AT = Date.UTC(2026, 8, 10);
  const window = () => ({ from: 0, to: Date.now() + 1000 });

  const call = (over: {
    agent: string;
    model?: string;
    run?: string;
    parent?: string;
    invoked?: string[];
    granted?: string[];
  }) => {
    const id = `c${n++}`;
    const model = over.model ?? "claude-haiku-4-5";
    const usage = { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 500 };
    const priced = priceUsage(model, usage);
    repository.recordCall({
      id,
      tenantId: "t1",
      agentId: over.agent,
      department: "Support",
      provider: "anthropic",
      model,
      startedAt: AT + n,
      durationMs: 10,
      streamed: false,
      usage,
      cost: priced.cost,
      priced: true,
      outcome: "ok",
      runId: over.run ?? id,
      runDeclared: over.run !== undefined,
      ...(over.parent ? { parentRunId: over.parent } : {}),
    });
    repository.recordTools({
      tenantId: "t1",
      callId: id,
      runId: over.run ?? id,
      agentId: over.agent,
      invoked: over.invoked ?? [],
      granted: over.granted ?? [],
      at: AT + n,
    });
  };

  const edge = (kind: string, from: string, to: string) =>
    analytics
      .topology("t1", window())
      .edges.find((e) => e.kind === kind && e.from === from && e.to === to);

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    analytics = new Analytics(db);
    repository.createTenant("Acme", "t1");
    n = 0;
  });

  afterEach(() => db.close());

  it("extracts agents, models and the edges between them", () => {
    call({ agent: "chat-bot", model: "claude-opus-5" });
    call({ agent: "chat-bot", model: "claude-haiku-4-5" });
    call({ agent: "lint-bot", model: "claude-haiku-4-5" });

    const topo = analytics.topology("t1", window());
    expect(topo.nodes.filter((node) => node.kind === "agent").map((node) => node.id).sort())
      .toEqual(["chat-bot", "lint-bot"]);
    expect(edge("invokes", "chat-bot", "claude-opus-5")?.calls).toBe(1);
    expect(edge("invokes", "lint-bot", "claude-haiku-4-5")?.calls).toBe(1);
  });

  it("separates a tool that was used from one merely granted", () => {
    call({ agent: "chat-bot", invoked: ["search_kb"], granted: ["search_kb", "refund_customer"] });

    // Capability the agent holds but has not exercised is still reachable, and
    // is exactly what a policy has to reason about before it is first used.
    expect(edge("uses", "chat-bot", "search_kb")?.calls).toBe(1);
    expect(edge("grants", "chat-bot", "refund_customer")).toBeDefined();
    // No duplicate grant edge where an invocation already implies it.
    expect(edge("grants", "chat-bot", "search_kb")).toBeUndefined();
  });

  it("keeps a granted tool after its window of use has passed", () => {
    call({ agent: "chat-bot", granted: ["refund_customer"] });

    // A capability does not lapse because it went unused this week.
    const future = { from: Date.now() + 10_000, to: Date.now() + 20_000 };
    expect(analytics.topology("t1", future).edges.some((e) => e.kind === "grants")).toBe(true);
  });

  it("draws a delegation edge between the agents of parent and child runs", () => {
    call({ agent: "chat-bot", run: "root" });
    call({ agent: "ticket-triage", run: "child", parent: "root" });

    expect(edge("delegates", "chat-bot", "ticket-triage")?.calls).toBe(1);
  });

  it("counts a delegation once per child call, not once per pair", () => {
    // Regression: joining call rows directly multiplies parent calls by child
    // calls. Three parents and two children reported six delegations where
    // there were two — wrong, and plausible enough to go unnoticed.
    for (let i = 0; i < 3; i += 1) call({ agent: "chat-bot", run: "root" });
    for (let i = 0; i < 2; i += 1) call({ agent: "ticket-triage", run: "child", parent: "root" });

    expect(edge("delegates", "chat-bot", "ticket-triage")?.calls).toBe(2);
  });

  it("does not draw a delegation edge for an agent handing work to itself", () => {
    // A step within one agent is not a hop between two.
    call({ agent: "chat-bot", run: "root" });
    call({ agent: "chat-bot", run: "child", parent: "root" });

    expect(analytics.topology("t1", window()).edges.some((e) => e.kind === "delegates")).toBe(false);
  });

  // ------------------------------------------------------------- reachability

  it("reports what an agent reaches through a delegation, not only directly", () => {
    call({ agent: "chat-bot", run: "root", granted: ["search_kb"] });
    call({ agent: "ticket-triage", run: "child", parent: "root", granted: ["refund_customer"] });

    const reach = analytics.reachableFrom("t1", window(), "chat-bot");
    expect(reach).toContain("search_kb"); // direct
    expect(reach).toContain("refund_customer"); // through ticket-triage
    expect(analytics.reachableFrom("t1", window(), "ticket-triage")).not.toContain("search_kb");
  });

  // ------------------------------------------------------------------ cycles

  it("finds a delegation loop", () => {
    call({ agent: "a", run: "r1" });
    call({ agent: "b", run: "r2", parent: "r1" });
    call({ agent: "a", run: "r3", parent: "r2" });

    const { cycles } = analytics.topology("t1", window());
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!].sort()).toEqual(["a", "b"]);
  });

  it("reports a loop once however it is entered", () => {
    // a->b->a and b->a->b are one cycle, not two.
    call({ agent: "a", run: "r1" });
    call({ agent: "b", run: "r2", parent: "r1" });
    call({ agent: "a", run: "r3", parent: "r2" });
    call({ agent: "b", run: "r4", parent: "r3" });

    expect(analytics.topology("t1", window()).cycles).toHaveLength(1);
  });

  it("does not call a diamond a cycle", () => {
    // a delegates to b and c, both delegate to d. No loop.
    call({ agent: "a", run: "r1" });
    call({ agent: "b", run: "r2", parent: "r1" });
    call({ agent: "c", run: "r3", parent: "r1" });
    call({ agent: "d", run: "r4", parent: "r2" });
    call({ agent: "d", run: "r5", parent: "r3" });

    expect(analytics.topology("t1", window()).cycles).toEqual([]);
  });

  it("finds a longer loop", () => {
    call({ agent: "a", run: "r1" });
    call({ agent: "b", run: "r2", parent: "r1" });
    call({ agent: "c", run: "r3", parent: "r2" });
    call({ agent: "a", run: "r4", parent: "r3" });

    const { cycles } = analytics.topology("t1", window());
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!].sort()).toEqual(["a", "b", "c"]);
  });

  it("survives a deep delegation chain without blowing the stack", () => {
    // Customer data decides this depth, so recursion would be a liability.
    call({ agent: "agent-0", run: "run-0" });
    for (let i = 1; i < 2_000; i += 1) {
      call({ agent: `agent-${i}`, run: `run-${i}`, parent: `run-${i - 1}` });
    }
    expect(() => analytics.topology("t1", window())).not.toThrow();
    expect(analytics.topology("t1", window()).cycles).toEqual([]);
  });

  it("is empty for a tenant with no traffic", () => {
    const topo = analytics.topology("t1", window());
    expect(topo).toEqual({ nodes: [], edges: [], cycles: [] });
  });
});
