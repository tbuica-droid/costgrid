import { priceUsage, ZERO_USAGE } from "@costgrid/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { Drift } from "../src/drift.js";
import { CostGridRepository } from "../src/repositories.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20);

describe("noticing what changed", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let drift: Drift;
  let seq = 0;

  const call = (o: {
    agent: string; at: number; model?: string; run?: string; parent?: string;
    depth?: number; granted?: string[]; invoked?: string[];
  }) => {
    const model = o.model ?? "claude-haiku-4-5";
    const usage = { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 100 };
    const priced = priceUsage(model, usage);
    const id = `c${(seq += 1)}`;
    repository.recordCall({
      id, tenantId: "t1", agentId: o.agent, department: "Eng", provider: "anthropic",
      model, startedAt: o.at, durationMs: 10, streamed: false, usage,
      cost: priced.cost, priced: priced.priced, outcome: "ok",
      runId: o.run ?? id, runDeclared: o.run !== undefined,
      ...(o.parent ? { parentRunId: o.parent } : {}),
      runDepth: o.depth ?? 0,
    });
    if (o.granted || o.invoked) {
      repository.recordTools({
        tenantId: "t1", callId: id, runId: o.run ?? id, agentId: o.agent,
        invoked: o.invoked ?? [], granted: o.granted ?? [], at: o.at,
      });
    }
  };

  /** Enough steady history for "never before" to mean something. */
  const establishBaseline = (agent = "worker") => {
    for (let d = 40; d > 8; d -= 1) {
      for (let i = 0; i < 20; i += 1) {
        call({ agent, at: NOW - d * DAY + i * 60_000, granted: ["search"], invoked: ["search"] });
      }
    }
  };

  const recent = () => ({ from: NOW - 7 * DAY, to: NOW + 1 });

  beforeEach(() => {
    seq = 0;
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    drift = new Drift(db);
    repository.createTenant("Acme", "t1");
  });

  afterEach(() => db.close());

  // ------------------------------------------------- the hallucination signal

  /*
   * The only kind of hallucination this product can honestly claim to detect.
   * The request carries the list of tools the model may call; an invocation
   * outside that list is the model producing the name itself.
   */
  it("catches a tool the model was never given", () => {
    call({ agent: "support", at: NOW - DAY, granted: ["search"], invoked: ["issue_refund"] });

    const found = drift.report("t1", recent()).signals.find((s) => s.kind === "invented-tool");
    expect(found).toBeDefined();
    expect(found!.subject).toBe("issue_refund");
    expect(found!.headline).toContain("never given");
  });

  it("reports an invented tool even with no history at all", () => {
    // Wrong on the first day as much as the hundredth.
    call({ agent: "support", at: NOW - DAY, granted: ["search"], invoked: ["wire_funds"] });

    const report = drift.report("t1", recent());
    expect(report.established).toBe(false);
    expect(report.signals.some((s) => s.kind === "invented-tool")).toBe(true);
  });

  it("does not flag a tool the request actually offered", () => {
    call({ agent: "support", at: NOW - DAY, granted: ["search", "refund"], invoked: ["refund"] });
    expect(drift.report("t1", recent()).signals.some((s) => s.kind === "invented-tool")).toBe(false);
  });

  it("puts invented tools above everything else", () => {
    establishBaseline("support");
    call({ agent: "brand-new", at: NOW - DAY });
    call({ agent: "support", at: NOW - DAY, granted: ["search"], invoked: ["issue_refund"] });

    expect(drift.report("t1", recent()).signals[0]!.kind).toBe("invented-tool");
  });

  /*
   * An invented tool is also, trivially, a tool never used before. Saying both
   * buries the half that matters.
   */
  it("does not also report an invented tool as merely new", () => {
    establishBaseline("support");
    call({ agent: "support", at: NOW - DAY, granted: ["search"], invoked: ["issue_refund"] });

    const signals = drift.report("t1", recent()).signals;
    expect(signals.filter((s) => s.subject === "issue_refund")).toHaveLength(1);
  });

  // ------------------------------------------------------------ the baseline

  it("says nothing about newness until there is enough history", () => {
    // A customer's first week: everything is new, and saying so is useless.
    for (let i = 0; i < 30; i += 1) call({ agent: "worker", at: NOW - DAY + i * 1000 });

    const report = drift.report("t1", recent());
    expect(report.established).toBe(false);
    expect(report.signals.filter((s) => s.kind !== "invented-tool")).toHaveLength(0);
  });

  it("reports nothing when a settled fleet keeps doing the same thing", () => {
    establishBaseline();
    for (let i = 0; i < 20; i += 1) {
      call({ agent: "worker", at: NOW - 2 * DAY + i * 60_000, granted: ["search"], invoked: ["search"] });
    }
    expect(drift.report("t1", recent()).signals).toHaveLength(0);
  });

  // --------------------------------------------------------------- newness

  it("spots a model an agent has never called", () => {
    establishBaseline();
    call({ agent: "worker", at: NOW - DAY, model: "claude-opus-5" });

    const found = drift.report("t1", recent()).signals.find((s) => s.kind === "new-model");
    expect(found?.subject).toBe("claude-opus-5");
  });

  it("spots an agent that has never run", () => {
    establishBaseline();
    call({ agent: "invoice-parser", at: NOW - DAY });

    const found = drift.report("t1", recent()).signals.find((s) => s.kind === "new-agent");
    expect(found?.agentId).toBe("invoice-parser");
  });

  it("spots work handed to someone new", () => {
    establishBaseline();
    call({ agent: "orchestrator", at: NOW - DAY, run: "r1" });
    call({ agent: "newcomer", at: NOW - DAY + 1000, run: "r2", parent: "r1" });

    const found = drift.report("t1", recent()).signals.find((s) => s.kind === "new-delegation");
    expect(found?.subject).toBe("newcomer");
  });

  // ---------------------------------------------------------------- spikes

  it("spots a run far longer than the agent has ever managed", () => {
    establishBaseline("looper");
    for (let d = 40; d > 8; d -= 1) {
      for (let s = 0; s < 4; s += 1) call({ agent: "looper", at: NOW - d * DAY + s * 1000, run: `base-${d}` });
    }
    for (let s = 0; s < 30; s += 1) call({ agent: "looper", at: NOW - DAY + s * 1000, run: "runaway" });

    const found = drift.report("t1", recent()).signals.find((s) => s.kind === "steps-spike");
    expect(found).toBeDefined();
    expect(found!.evidence).toContain("had ever run before was 4");
  });

  it("reports one spike per agent, not one per run", () => {
    establishBaseline("looper");
    for (let d = 40; d > 8; d -= 1) {
      for (let s = 0; s < 3; s += 1) call({ agent: "looper", at: NOW - d * DAY + s * 1000, run: `base-${d}` });
    }
    // Three runaway runs. A storm produces many; listing each buries the rest.
    for (let r = 0; r < 3; r += 1) {
      for (let s = 0; s < 40; s += 1) {
        call({ agent: "looper", at: NOW - DAY + r * 3600_000 + s * 1000, run: `runaway-${r}` });
      }
    }
    expect(drift.report("t1", recent()).signals.filter((s) => s.kind === "steps-spike")).toHaveLength(1);
  });

  it("ignores runs the caller never declared", () => {
    establishBaseline("looper");
    // No run header, so these are 40 separate runs of one, not one long run.
    for (let s = 0; s < 40; s += 1) call({ agent: "looper", at: NOW - DAY + s * 1000 });

    expect(drift.report("t1", recent()).signals.some((s) => s.kind === "steps-spike")).toBe(false);
  });

  it("keeps one tenant's behaviour out of another's", () => {
    repository.createTenant("Other", "t2");
    establishBaseline();
    call({ agent: "worker", at: NOW - DAY, granted: ["search"], invoked: ["invented"] });

    expect(drift.report("t2", recent()).signals).toHaveLength(0);
  });
});
