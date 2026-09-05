import { priceUsage, ZERO_USAGE } from "@costgrid/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Analytics } from "../src/analytics.js";
import { trailingWindow } from "../src/analytics.js";
import { openDatabase } from "../src/database.js";
import { CostGridRepository } from "../src/repositories.js";

describe("trailingWindow", () => {
  /*
   * Regression: TimeRange is half-open, so a call recorded in the same
   * millisecond as the query has `started_at === to` and is excluded by
   * `started_at < to`. Every caller used to build `to = Date.now()` by hand,
   * which made the newest calls appear or vanish depending on how the
   * millisecond boundary happened to fall — a genuinely intermittent
   * under-count on a busy gateway, not just a flaky test.
   */
  it("includes a call recorded at this exact instant", () => {
    const now = 1_700_000_000_000;
    const window = trailingWindow(30, now);

    expect(now).toBeGreaterThanOrEqual(window.from);
    expect(now).toBeLessThan(window.to);
  });

  it("spans the requested number of days", () => {
    const now = 1_700_000_000_000;
    expect(trailingWindow(1, now).from).toBe(now - 86_400_000);
    expect(trailingWindow(30, now).from).toBe(now - 30 * 86_400_000);
  });

  it("rejects a nonsensical day count", () => {
    expect(() => trailingWindow(0)).toThrow(/days must be/);
    expect(() => trailingWindow(1.5)).toThrow(/days must be/);
    expect(() => trailingWindow(99_999)).toThrow(/days must be/);
  });
});

describe("analytics", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;

  const record = (model: string, agent: string, at: number, outcome: "ok" | "error" = "ok") => {
    const usage = { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 500 };
    const priced = priceUsage(model, usage);
    repository.recordCall({
      id: `${agent}-${at}-${Math.random()}`,
      tenantId: "t1",
      agentId: agent,
      department: "Eng",
      provider: "anthropic",
      model,
      startedAt: at,
      durationMs: 10,
      streamed: false,
      usage,
      cost: priced.cost,
      priced: priced.priced,
      outcome,
    });
  };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    analytics = new Analytics(db);
    repository.createTenant("Acme", "t1");
  });

  afterEach(() => db.close());

  it("counts a call landing on the upper bound of a trailing window", () => {
    const now = Date.now();
    record("claude-opus-5", "a", now);

    // The pathological case: query with `now` as the reference instant.
    const summary = analytics.summary("t1", trailingWindow(1, now));
    expect(summary.calls).toBe(1);

    const tiers = analytics.tierBreakdown("t1", trailingWindow(1, now));
    expect(tiers.find((t) => t.tier === "frontier")?.calls).toBe(1);
  });

  it("excludes calls older than the window", () => {
    const now = Date.now();
    record("claude-opus-5", "a", now - 40 * 86_400_000);
    record("claude-opus-5", "a", now);

    expect(analytics.summary("t1", trailingWindow(30, now)).calls).toBe(1);
    expect(analytics.summary("t1", trailingWindow(90, now)).calls).toBe(2);
  });

  it("keeps errored calls out of spend but visible in counts", () => {
    const now = Date.now();
    record("claude-opus-5", "a", now, "ok");
    record("claude-opus-5", "a", now, "error");

    const summary = analytics.summary("t1", trailingWindow(1, now));
    expect(summary.calls).toBe(2);
    expect(summary.erroredCalls).toBe(1);
    // Only the successful call contributed cost.
    expect(summary.totalCost).toBe(priceUsage("claude-opus-5", {
      ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 500,
    }).cost.total);
  });

  it("computes per-agent cost per successful call", () => {
    const now = Date.now();
    record("claude-haiku-4-5", "classifier", now);
    record("claude-haiku-4-5", "classifier", now);

    const [agent] = analytics.agentDetail("t1", trailingWindow(1, now));
    expect(agent?.calls).toBe(2);
    expect(agent?.costPerCall).toBe(agent!.cost / 2n);
  });

  it("labels an uncatalogued model's tier as unknown rather than guessing", () => {
    const now = Date.now();
    record("claude-opus-5", "a", now);
    record("some-unreleased-model", "b", now);

    const tiers = analytics.tierBreakdown("t1", trailingWindow(1, now));
    expect(tiers.map((t) => t.tier).sort()).toEqual(["frontier", "unknown"]);
  });

  it("excludes uncatalogued models from substitution share entirely", () => {
    const now = Date.now();
    record("claude-opus-5", "a", now); // frontier
    record("claude-haiku-4-5", "b", now); // small
    record("some-unreleased-model", "c", now); // unknown tier

    // 1 of the 2 *classifiable* calls is off-frontier. The unknown model is
    // counted on neither side rather than being assumed cheap.
    expect(analytics.substitutionShare("t1", trailingWindow(1, now))).toBeCloseTo(0.5, 6);
  });

  it("isolates tenants", () => {
    const now = Date.now();
    repository.createTenant("Other", "t2");
    record("claude-opus-5", "a", now);

    expect(analytics.summary("t1", trailingWindow(1, now)).calls).toBe(1);
    expect(analytics.summary("t2", trailingWindow(1, now)).calls).toBe(0);
  });
});
