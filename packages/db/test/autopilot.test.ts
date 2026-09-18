import { priceUsage, usd, ZERO_USAGE } from "@costgrid/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Autopilot } from "../src/autopilot.js";
import { openDatabase } from "../src/database.js";
import { CostGridRepository } from "../src/repositories.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 10);

describe("autopilot", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let pilot: Autopilot;
  let seq = 0;

  const record = (over: { agent?: string; model?: string; at?: number; out?: number } = {}) => {
    const model = over.model ?? "claude-opus-5";
    const usage = { ...ZERO_USAGE, inputTokens: 40_000, outputTokens: over.out ?? 150 };
    const priced = priceUsage(model, usage);
    const id = `c${(seq += 1)}`;
    repository.recordCall({
      id,
      tenantId: "t1",
      agentId: over.agent ?? "classifier",
      department: "Support",
      provider: "anthropic",
      model,
      startedAt: over.at ?? T0,
      durationMs: 10,
      streamed: false,
      usage,
      cost: priced.cost,
      priced: priced.priced,
      outcome: "ok",
      runId: id,
      runDeclared: false,
    });
  };

  /** Enough expensive short-answer traffic to produce a routing proposal. */
  const seedRoutable = (agent = "classifier") => {
    for (let i = 0; i < 120; i += 1) record({ agent, at: T0 + i * 60_000 });
  };

  const window = () => ({ from: T0 - 30 * DAY, to: T0 + 30 * DAY });

  beforeEach(() => {
    seq = 0;
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    pilot = new Autopilot(db);
    repository.createTenant("Acme", "t1");
  });

  afterEach(() => db.close());

  it("is off, and does nothing, until someone turns it on", () => {
    seedRoutable();
    expect(pilot.settings("t1").level).toBe("off");

    const result = pilot.run("t1", window());
    expect(result.taken).toHaveLength(0);
    expect(repository.listPolicies("t1")).toHaveLength(0);
  });

  it("creates a rule that changes nothing at the monitor level", () => {
    seedRoutable();
    pilot.configure("t1", { level: "monitor" });

    const result = pilot.run("t1", window());
    expect(result.taken).toHaveLength(1);

    const policies = repository.listPolicies("t1");
    expect(policies).toHaveLength(1);
    expect(policies[0]!.rule.kind).toBe("route");
    // The whole point of this level: a dry run. Not one request is altered.
    expect(policies[0]!.action).toBe("monitor");
  });

  it("switches the rule on at the apply level", () => {
    seedRoutable();
    pilot.configure("t1", { level: "apply", maxImpactPct: 100 });
    pilot.run("t1", window());

    expect(repository.listPolicies("t1")[0]!.action).toBe("warn");
  });

  /*
   * The boundary that makes this safe to ship. Routing serves a cheaper
   * answer; everything else either refuses a customer's traffic or commits
   * their organisation to a number.
   */
  it("refuses to create anything that could refuse a call", () => {
    seedRoutable();
    // Long runs and unguarded spend both produce proposals here.
    pilot.configure("t1", { level: "apply", maxActions: 20 });
    const result = pilot.run("t1", window());

    for (const action of result.taken) {
      const policy = repository.listPolicies("t1").find((p) => p.id === action.policyId);
      expect(policy!.rule.kind).toBe("route");
    }
    const declinedKinds = result.declined.map((d) => d.because).join(" ");
    expect(declinedKinds).toContain("only creates routing rules");
  });

  it("never sets a budget, however much is unguarded", () => {
    seedRoutable();
    pilot.configure("t1", { level: "apply", maxActions: 20 });
    pilot.run("t1", window());

    for (const policy of repository.listPolicies("t1")) {
      expect(policy.rule.kind).not.toBe("budget");
    }
  });

  it("stops at the blast-radius limit and says so", () => {
    seedRoutable();
    // One agent is all the traffic, so any rule covers 100% of spend.
    pilot.configure("t1", { level: "apply", maxImpactPct: 5 });

    const result = pilot.run("t1", window());
    expect(result.taken).toHaveLength(0);
    expect(result.declined.some((d) => d.because.includes("5% limit") || d.because.includes("limit you set"))).toBe(true);
  });

  it("stops at the action limit and says so", () => {
    seedRoutable("a");
    seedRoutable("b");
    pilot.configure("t1", { level: "monitor", maxActions: 1 });

    const result = pilot.run("t1", window());
    expect(result.taken).toHaveLength(1);
    expect(result.declined.some((d) => d.because.includes("which is the limit"))).toBe(true);
  });

  it("does not create the same rule twice", () => {
    seedRoutable();
    pilot.configure("t1", { level: "monitor" });

    pilot.run("t1", window());
    const second = pilot.run("t1", window());

    expect(second.taken).toHaveLength(0);
    expect(repository.listPolicies("t1")).toHaveLength(1);
    expect(second.declined.some((d) => d.because.includes("already exists"))).toBe(true);
  });

  it("explains every proposal it passed over", () => {
    seedRoutable();
    pilot.configure("t1", { level: "monitor", maxActions: 20 });

    const result = pilot.run("t1", window());
    // Silence is indistinguishable from being broken, so nothing is skipped
    // without a reason a person can read.
    expect(result.considered).toBe(result.taken.length + result.declined.length);
    for (const d of result.declined) expect(d.because.length).toBeGreaterThan(10);
  });

  it("records what it did and the figures that justified it", () => {
    seedRoutable();
    pilot.configure("t1", { level: "apply", maxImpactPct: 100 });
    pilot.run("t1", window());

    const actions = pilot.actions("t1");
    expect(actions).toHaveLength(1);
    expect(actions[0]!.evidence).toMatch(/Replay over the window/);
    expect(actions[0]!.evidence).toMatch(/\$\d/);
    expect(actions[0]!.level).toBe("apply");
  });

  // ------------------------------------------------------------------ undo

  it("undoes everything it created, in one call", () => {
    seedRoutable("a");
    seedRoutable("b");
    pilot.configure("t1", { level: "apply", maxActions: 20, maxImpactPct: 100 });
    pilot.run("t1", window());

    const created = repository.listPolicies("t1").filter((p) => p.enabled).length;
    expect(created).toBeGreaterThan(0);

    expect(pilot.undoAll("t1")).toBe(created);
    expect(repository.listPolicies("t1").every((p) => !p.enabled)).toBe(true);
  });

  it("leaves rules a person created alone", () => {
    seedRoutable();
    const mine = repository.createPolicy("t1", {
      name: "my own cap",
      scope: { kind: "tenant" },
      rule: { kind: "budget", window: "month", limit: usd("500.00") },
      action: "block",
      enabled: true,
    });
    pilot.configure("t1", { level: "apply" });
    pilot.run("t1", window());
    pilot.undoAll("t1");

    const still = repository.listPolicies("t1").find((p) => p.id === mine);
    expect(still!.enabled).toBe(true);
  });

  it("keeps the record after undoing, rather than tidying it away", () => {
    seedRoutable();
    pilot.configure("t1", { level: "monitor" });
    pilot.run("t1", window());
    pilot.undoAll("t1");

    const actions = pilot.actions("t1");
    expect(actions).toHaveLength(1);
    // "CostGrid changed something and I cannot tell what" is the fear this
    // feature has to answer; an empty table answers it badly.
    expect(actions[0]!.undoneAt).toBeGreaterThan(0);
  });

  it("is idempotent when there is nothing to undo", () => {
    expect(pilot.undoAll("t1")).toBe(0);
    expect(pilot.undoAll("t1")).toBe(0);
  });
});
