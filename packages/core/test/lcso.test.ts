import { describe, expect, it } from "vitest";
import { usd } from "../src/money.js";
import { formatPercent, formatRatio, formatUsdPerOutcome, ratio, ratioEquals } from "../src/ratio.js";
import { computeLcso, computeLcsoAggregate, coverage } from "../src/lcso.js";
import type { HumanTimeEntry, LcsoInput, LcsoTask, OutcomeState } from "../src/lcso-types.js";
import { AS_OF, DAY, WINDOW, baseInput as input, reason, value } from "./fixtures/lcso-base.js";
import { section14AggregateInput, section14Input } from "./fixtures/lcso-section14.js";

/** A task with one run per cost, resolved well outside its window unless told otherwise. */
function task(id: string, state: OutcomeState, costs: readonly string[], extra: Partial<LcsoTask> = {}): LcsoTask {
  const runs = costs.map((cost, j) => ({ runId: `${id}-r${j + 1}`, cost: usd(cost), startedAt: j }));
  const base: LcsoTask = state === "PENDING" ? { taskId: id, state, runs } : { taskId: id, state, runs, resolvedAt: AS_OF - 10 * DAY };
  return { ...base, ...extra };
}

const hour = usd(60); // $1 a minute keeps human arithmetic readable

describe("LCSO §14 worked example", () => {
  const result = computeLcso(section14Input());

  it("reproduces the three layers exactly", () => {
    expect(result.methodologyVersion).toBe("0.1");
    expect(ratioEquals(value(result.lcso.lcso1), ratio(usd("3040"), 7800n))).toBe(true);
    expect(formatUsdPerOutcome(value(result.lcso.lcso1))).toBe("0.390");
    expect(formatUsdPerOutcome(value(result.lcso.lcso2))).toBe("1.008");
    expect(formatUsdPerOutcome(value(result.lcso.lcso3))).toBe("1.521");
  });

  it("reproduces the counts and components", () => {
    expect(result.counts).toMatchObject({ resolved: 9800, success: 7800, failure: 1500, abandoned: 500, pending: 200, pendingMaturing: 50 });
    expect(result.components.model).toBe(usd("3040"));
    expect(result.components.modelNonFinalSuccessRuns).toBe(usd("330"));
    expect(result.components.human.estimated).toBe(usd("4824"));
    expect(result.components.human.measured).toBe(0n);
    expect(result.components.fixed).toEqual({ total: usd("4000"), allocationKeys: ["dedicated"] });
    expect(result.carriedForward).toEqual({ tasks: 200, model: usd("60"), human: 0n });
  });

  it("reproduces FCS, spread and the rates", () => {
    expect(ratioEquals(value(result.failureCostShare), ratio(1160n, 3040n))).toBe(true);
    expect(formatPercent(value(result.failureCostShare), 1)).toBe("38.2");
    const spread = value(result.spread);
    expect([spread.p50, spread.p90, spread.p99]).toEqual([usd("0.22"), usd("0.71"), usd("2.90")]);
    expect(formatRatio(value(spread.spreadRatio), 1)).toBe("3.2");
    expect(spread.tailTaskCount).toBe(490);
    expect(ratioEquals(value(spread.tailShare), ratio(729n, 3040n))).toBe(true);
    expect(formatPercent(value(result.rates.success), 1)).toBe("79.6");
    expect(ratioEquals(value(result.rates.autonomy), ratio(7488n, 7800n))).toBe(true);
    expect(formatRatio(value(result.her).ratio, 2)).toBe("0.23");
    expect(result.flags).toEqual(["human-cost-estimated"]);
  });

  it("reconciles the provider bill at 98.4%", () => {
    const cov = coverage(usd("3050.40"), usd("3100"));
    expect(ratioEquals(cov.ratio!, ratio(984n, 1000n))).toBe(true);
    expect(cov.band).toBe("complete");
    expect(cov.unattributed).toBe(usd("49.60"));
  });

  it("gives the same layers from totals alone", () => {
    const agg = computeLcsoAggregate(section14AggregateInput());
    expect(agg.mode).toBe("aggregate");
    expect(agg.asOf).toBeNull();
    expect(formatUsdPerOutcome(value(agg.lcso.lcso1))).toBe("0.390");
    expect(formatUsdPerOutcome(value(agg.lcso.lcso2))).toBe("1.008");
    expect(formatUsdPerOutcome(value(agg.lcso.lcso3))).toBe("1.521");
    expect(reason(agg.failureCostShare)).toBe("aggregate-mode");
    expect(reason(agg.spread)).toBe("aggregate-mode");
  });
});

describe("per-task counting", () => {
  it("counts a task once however many runs it took", () => {
    const once = computeLcso(input([task("a", "SUCCESS", ["1"]), task("b", "FAILURE", ["1"])]));
    const retried = computeLcso(input([task("a", "SUCCESS", ["1", "1", "1"]), task("b", "FAILURE", ["1"])]));
    expect(retried.counts.success).toBe(1);
    expect(retried.rates.success).toEqual(once.rates.success);
    expect(retried.components.modelNonFinalSuccessRuns).toBe(usd("2"));
    expect(formatUsdPerOutcome(value(retried.lcso.lcso1))).toBe("4.000");
  });
});

describe("maturation", () => {
  it("counts a success whose window ends exactly at asOf, and holds one that ends later", () => {
    const result = computeLcso(
      input([
        task("matured", "SUCCESS", ["1"], { resolvedAt: AS_OF - WINDOW }),
        task("maturing", "SUCCESS", ["2"], { resolvedAt: AS_OF - WINDOW + 1 }),
      ]),
    );
    expect(result.counts).toMatchObject({ success: 1, pending: 1, pendingMaturing: 1 });
    expect(result.components.model).toBe(usd("1"));
    expect(result.carriedForward).toMatchObject({ tasks: 1, model: usd("2") });
  });

  it("keeps explicit PENDING tasks out of both sides", () => {
    const result = computeLcso(input([task("p1", "PENDING", ["3"]), task("p2", "PENDING", ["4"])]));
    expect(result.counts).toMatchObject({ resolved: 0, pending: 2, pendingMaturing: 0 });
    expect(result.components.model).toBe(0n);
    expect(result.carriedForward.model).toBe(usd("7"));
    expect(result.flags).toContain("no-resolved-tasks");
  });
});

describe("clawback", () => {
  const resolvedAt = AS_OF - 10 * DAY;

  it("turns a success reversed inside its window into a failure", () => {
    const result = computeLcso(
      input([task("kept", "SUCCESS", ["1"]), task("reopened", "SUCCESS", ["1"], { resolvedAt, reversedAt: resolvedAt + WINDOW })]),
    );
    expect(result.counts).toMatchObject({ success: 1, failure: 1, clawedBack: 1 });
    expect(value(result.rates.clawback)).toEqual(ratio(1n, 2n));
    expect(value(result.failureCostShare)).toEqual(ratio(usd("1"), usd("2")));
  });

  it("claws back a success still inside its window", () => {
    const result = computeLcso(input([task("x", "SUCCESS", ["1"], { resolvedAt: AS_OF - DAY, reversedAt: AS_OF })]));
    expect(result.counts).toMatchObject({ failure: 1, clawedBack: 1, pendingMaturing: 0 });
  });

  it("discloses a reversal after the window as a prior-period adjustment without restating", () => {
    const reversedAt = resolvedAt + WINDOW + 1;
    const result = computeLcso(input([task("late", "SUCCESS", ["1"], { resolvedAt, reversedAt })]));
    expect(result.counts).toMatchObject({ success: 1, clawedBack: 0 });
    expect(result.priorPeriodAdjustments).toEqual([{ taskId: "late", reversedAt }]);
    expect(result.flags).toContain("prior-period-adjustment");
  });
});

describe("UNKNOWN outcomes", () => {
  it("are failures for rates and FCS, counted and flagged separately", () => {
    const result = computeLcso(input([task("s", "SUCCESS", ["1"]), task("u", "UNKNOWN", ["3"])]));
    expect(result.counts).toMatchObject({ success: 1, failure: 0, unknown: 1, resolved: 2 });
    expect(value(result.rates.success)).toEqual(ratio(1n, 2n));
    expect(value(result.failureCostShare)).toEqual(ratio(usd("3"), usd("4")));
    expect(result.flags).toContain("unknown-outcomes-present");
  });
});

describe("degenerate inputs", () => {
  it("withholds every per-success figure when nothing succeeded, and says spend went somewhere", () => {
    const result = computeLcso(input([task("f", "FAILURE", ["2"])], { humanBaseline: { costPerOutcome: usd(5), source: "s", date: "d", method: "m" } }));
    expect(reason(result.lcso.lcso1)).toBe("no-successes");
    expect(reason(result.lcso.lcso3)).toBe("no-successes");
    expect(reason(result.her)).toBe("no-successes");
    expect(reason(result.rates.clawback)).toBe("no-successes");
    expect(value(result.rates.success)).toEqual(ratio(0n, 1n));
    expect(result.flags).toContain("spend-but-no-successes");
  });

  it("reports an empty input without inventing zeros", () => {
    const result = computeLcso(input([]));
    expect(result.counts.resolved).toBe(0);
    expect(reason(result.spread)).toBe("no-resolved-tasks");
    expect(reason(result.rates.success)).toBe("no-resolved-tasks");
    expect(reason(result.failureCostShare)).toBe("zero-model-cost");
    expect(reason(result.lcso.lcso1)).toBe("no-successes");
    expect(result.flags).toEqual(["no-resolved-tasks"]);
  });

  it("reports zero model cost as a zero LCSO-1 but withholds the shares", () => {
    const result = computeLcso(input([task("a", "SUCCESS", ["0"]), task("b", "SUCCESS", ["0"])]));
    expect(value(result.lcso.lcso1)).toEqual(ratio(0n, 2n));
    expect(reason(result.failureCostShare)).toBe("zero-model-cost");
    expect(reason(value(result.spread).tailShare)).toBe("zero-model-cost");
    expect(reason(value(result.spread).spreadRatio)).toBe("zero-median");
  });

  it("withholds the spread ratio when the median task cost nothing", () => {
    const result = computeLcso(input([task("a", "SUCCESS", ["0"]), task("b", "SUCCESS", ["0"]), task("c", "SUCCESS", ["1"])]));
    const spread = value(result.spread);
    expect(spread.p50).toBe(0n);
    expect(reason(spread.spreadRatio)).toBe("zero-median");
    expect(value(spread.tailShare)).toEqual(ratio(usd("1"), usd("1")));
  });

  it("does not flag a pending task that has no runs yet", () => {
    const result = computeLcso(input([task("s", "SUCCESS", ["1"]), task("p", "PENDING", [])]));
    expect(result.counts.withoutRuns).toBe(0);
    expect(result.flags).not.toContain("tasks-without-runs");
  });

  it("counts a task with no runs at zero cost and flags it", () => {
    const result = computeLcso(input([task("a", "SUCCESS", []), task("b", "SUCCESS", ["1"])]));
    expect(result.counts.withoutRuns).toBe(1);
    expect(result.components.model).toBe(usd("1"));
    expect(result.flags).toContain("tasks-without-runs");
  });

  it("flags a mostly Tier C evidence mix", () => {
    const result = computeLcso(
      input([task("a", "SUCCESS", ["1"], { evidenceTier: "C" }), task("b", "SUCCESS", ["1"], { evidenceTier: "C" }), task("c", "SUCCESS", ["1"])]),
    );
    expect(result.evidenceTiers).toEqual({ A: 0, B: 0, C: 2, none: 1 });
    expect(result.flags).toContain("mostly-tier-c");
  });
});

describe("final run", () => {
  const runs = [
    { runId: "r1", cost: usd(1), startedAt: 1 },
    { runId: "r2", cost: usd(3), startedAt: 2 },
  ];

  it("defaults to the last run by start time, then run id", () => {
    expect(computeLcso(input([{ ...task("t", "SUCCESS", []), runs }])).components.modelNonFinalSuccessRuns).toBe(usd(1));
    const tied = runs.map((run) => ({ ...run, startedAt: 5 }));
    expect(computeLcso(input([{ ...task("t", "SUCCESS", []), runs: tied }])).components.modelNonFinalSuccessRuns).toBe(usd(1));
  });

  it("uses the run the caller names", () => {
    const result = computeLcso(input([{ ...task("t", "SUCCESS", []), runs, finalRunId: "r1" }]));
    expect(result.components.modelNonFinalSuccessRuns).toBe(usd(3));
  });
});

describe("human time", () => {
  it("keeps measured and estimated apart and carries pending tasks forward", () => {
    const entries: HumanTimeEntry[] = [
      { activity: "review", minutes: 10, hourlyRate: hour, basis: "measured", taskId: "s" },
      { activity: "handoff", minutes: 5, hourlyRate: hour, basis: "estimated", taskId: "f" },
      { activity: "review", minutes: 7, hourlyRate: hour, basis: "measured", taskId: "p" },
    ];
    const result = computeLcso(
      input([task("s", "SUCCESS", ["1"]), task("f", "FAILURE", ["1"]), task("p", "PENDING", ["1"])], { human: { entries, reworkTracked: false } }),
    );
    const human = result.components.human;
    expect(human).toMatchObject({ measured: usd(10), estimated: usd(5), total: usd(15), minutes: { measured: 10, estimated: 5 } });
    expect(human.byActivity.handoff.estimated).toBe(usd(5));
    expect(result.carriedForward.human).toBe(usd(7));
    expect(value(result.lcso.lcso2)).toEqual(ratio(usd(17), 1n));
    expect(result.flags).toContain("human-cost-estimated");
  });

  it("rounds each bucket once, not each entry", () => {
    const minute = { activity: "review", minutes: 1, hourlyRate: usd(1), basis: "measured" } as const;
    const result = computeLcso(input([task("s", "SUCCESS", ["1"])], { human: { entries: [minute, minute], reworkTracked: false } }));
    expect(result.components.human.measured).toBe(33_333_333n); // 2e9/60, not 2 x round(1e9/60)
  });
});

describe("HER and autonomy", () => {
  const baseline = { costPerOutcome: usd(4), source: "payroll", date: "2026-01", method: "payroll data" };

  it("reports HER only against a documented baseline", () => {
    const tasks = [task("s", "SUCCESS", ["1"])];
    expect(value(computeLcso(input(tasks, { humanBaseline: baseline })).her)).toEqual({ ratio: ratio(usd(1), usd(4)), baseline });
    expect(reason(computeLcso(input(tasks)).her)).toBe("no-human-baseline");
  });

  it("reports autonomy only when rework is tracked, counting reworked successes once", () => {
    const rework = (taskId: string): HumanTimeEntry => ({ activity: "rework", minutes: 3, hourlyRate: hour, basis: "measured", taskId });
    const tasks = [task("a", "SUCCESS", ["1"]), task("b", "SUCCESS", ["1"]), task("f", "FAILURE", ["1"])];
    const entries = [rework("a"), rework("a"), rework("f")];
    expect(value(computeLcso(input(tasks, { human: { entries, reworkTracked: true } })).rates.autonomy)).toEqual(ratio(1n, 2n));
    expect(reason(computeLcso(input(tasks, { human: { entries, reworkTracked: false } })).rates.autonomy)).toBe("rework-not-tracked");
    expect(reason(computeLcso(input(tasks)).rates.autonomy)).toBe("rework-not-tracked");
  });
});

describe("aggregate mode", () => {
  const { workflowId, period, successDefinition, modelCost, successCount } = section14AggregateInput();
  const plain = { workflowId, period, successDefinition, modelCost, successCount };

  it("needs every failure count for a success rate", () => {
    const partial = computeLcsoAggregate({ ...plain, failureCount: 1500 });
    expect(reason(partial.rates.success)).toBe("counts-not-supplied");
    const full = computeLcsoAggregate({ ...plain, failureCount: 1500, abandonedCount: 500, unknownCount: 0 });
    expect(formatPercent(value(full.rates.success), 1)).toBe("79.6");
    expect(full.counts.resolved).toBe(9800);
  });

  it("always discloses that its spend may include unresolved work", () => {
    const result = computeLcsoAggregate({ ...plain, unknownCount: 3 });
    expect(result.flags).toEqual([
      "unknown-outcomes-present",
      "aggregate-includes-unresolved-spend",
      "failure-counts-not-supplied",
    ]);
    expect(reason(result.rates.clawback)).toBe("aggregate-mode");
    expect(reason(result.rates.autonomy)).toBe("rework-not-tracked");
  });

  it("flags spend with no successes instead of rejecting untracked rework", () => {
    const rework: HumanTimeEntry = { activity: "rework", minutes: 5, hourlyRate: hour, basis: "measured", taskCount: 3 };
    const result = computeLcsoAggregate({ ...plain, successCount: 0, human: { entries: [rework], reworkTracked: false } });
    expect(reason(result.lcso.lcso1)).toBe("no-successes");
    expect(result.flags).toContain("spend-but-no-successes");
  });

  it("validates its counts and cost", () => {
    expect(() => computeLcsoAggregate({ ...plain, successCount: -1 })).toThrow(expect.objectContaining({ code: "invalid-count" }));
    expect(() => computeLcsoAggregate({ ...plain, modelCost: -1n })).toThrow(expect.objectContaining({ code: "negative-cost" }));
  });
});

describe("input validation", () => {
  const ok = task("s", "SUCCESS", ["1"]);
  const entry = (extra: Partial<HumanTimeEntry>): HumanTimeEntry => ({ activity: "review", minutes: 1, hourlyRate: hour, basis: "measured", ...extra });
  const withHuman = (entries: HumanTimeEntry[], reworkTracked = false) => input([ok], { human: { entries, reworkTracked } });
  const cases: [string, LcsoInput][] = [
    ["duplicate-task-id", input([ok, ok])],
    ["duplicate-run-id", input([ok, { ...task("t", "FAILURE", []), runs: ok.runs }])],
    ["negative-cost", input([task("n", "FAILURE", ["-1"])])],
    ["negative-cost", input([ok], { toolCosts: [{ ref: "api", amount: -1n }] })],
    ["negative-cost", input([ok], { fixedCosts: [{ ref: "gl", amount: -1n }] })],
    ["negative-cost", withHuman([entry({ hourlyRate: -1n })])],
    ["invalid-minutes", withHuman([entry({ minutes: 1.5 })])],
    ["invalid-minutes", withHuman([entry({ minutes: -1 })])],
    ["invalid-count", withHuman([entry({ taskCount: -1 })])],
    ["invalid-count", withHuman([entry({ taskId: "s", taskCount: 1 })])],
    ["invalid-count", withHuman([entry({ activity: "rework" })], true)],
    ["invalid-maturation-window", input([ok], { successDefinition: { id: "d", version: "1", maturationWindowMs: -1 } })],
    ["missing-resolved-at", input([{ taskId: "s", state: "SUCCESS", runs: [] }])],
    ["reversal-on-non-success", input([task("f", "FAILURE", ["1"], { reversedAt: AS_OF })])],
    ["reversal-before-resolution", input([task("s", "SUCCESS", ["1"], { reversedAt: AS_OF - 11 * DAY })])],
    ["reversal-in-future", input([task("s", "SUCCESS", ["1"], { reversedAt: AS_OF + 1 })])],
    ["unknown-final-run", input([task("s", "SUCCESS", ["1"], { finalRunId: "nope" })])],
    ["unknown-task-id", withHuman([entry({ taskId: "ghost" })])],
    ["rework-exceeds-successes", withHuman([entry({ activity: "rework", taskCount: 2 })], true)],
    ["invalid-baseline", input([ok], { humanBaseline: { costPerOutcome: 0n, source: "s", date: "d", method: "m" } })],
    ["invalid-timestamp", input([task("s", "SUCCESS", ["1"], { resolvedAt: Number.NaN })])],
    ["invalid-timestamp", input([task("s", "SUCCESS", ["1"], { reversedAt: Number.POSITIVE_INFINITY })])],
    ["invalid-timestamp", input([ok], { asOf: Number.NaN })],
    ["invalid-value", input([{ ...ok, state: "SUCCEEDED" as OutcomeState }])],
    ["invalid-value", input([{ ...ok, evidenceTier: "D" as "A" }])],
    ["invalid-value", withHuman([entry({ activity: "qa" as "review" })])],
  ];

  it.each(cases)("rejects %s", (code, bad) => {
    expect(() => computeLcso(bad)).toThrow(expect.objectContaining({ name: "LcsoInputError", code }));
  });
});

describe("coverage", () => {
  it("puts exactly 98% and exactly 90% in the higher band", () => {
    expect(coverage(usd(98), usd(100)).band).toBe("complete");
    expect(coverage(usd("97.99"), usd(100)).band).toBe("disclosed");
    expect(coverage(usd(90), usd(100))).toMatchObject({ band: "disclosed", unattributed: usd(10) });
    expect(coverage(usd("89.99"), usd(100)).band).toBe("withheld");
  });

  it("handles zero bills and over-observation", () => {
    expect(coverage(0n, 0n)).toEqual({ ratio: null, band: "complete", unattributed: 0n, observedExceedsBilled: false });
    expect(coverage(usd(1), 0n)).toMatchObject({ ratio: null, band: "withheld", observedExceedsBilled: true });
    expect(coverage(usd(101), usd(100))).toMatchObject({ band: "complete", unattributed: 0n, observedExceedsBilled: true });
    expect(() => coverage(-1n, usd(1))).toThrow(RangeError);
  });
});
