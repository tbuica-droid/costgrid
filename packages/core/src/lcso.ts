import { mulDiv, sumNano, type Nanodollars } from "./money.js";
import { compareRatio, ratio, type Ratio } from "./ratio.js";
import { compareBigint, nearestRank, nearestRankIndex } from "./stats.js";
import {
  COST_BASES,
  EVIDENCE_TIERS,
  HUMAN_ACTIVITIES,
  LCSO_FLAGS,
  LCSO_METHODOLOGY_VERSION,
  LcsoInputError,
  OUTCOME_STATES,
  type Coverage,
  type CostBasis,
  type HumanActivity,
  type HumanBuckets,
  type HumanComponent,
  type LcsoAggregateInput,
  type LcsoCommonInput,
  type LcsoFlag,
  type LcsoInput,
  type LcsoInputErrorCode,
  type LcsoResult,
  type LcsoRun,
  type LcsoSpread,
  type LcsoTask,
  type NotReportedReason,
  type Reported,
} from "./lcso-types.js";

/**
 * The LCSO engine: what one successful business outcome of an AI workflow
 * actually costs, all-in (methodology v0.1, `docs/strategy`).
 *
 * Re-performable by construction. Money stays in nanodollars, every quotient
 * is an exact `Ratio`, percentiles are nearest-rank over integers, and the
 * result does not depend on the order tasks or runs arrive in. The same
 * inputs give a deep-equal result on any machine.
 *
 * Conservative where a rule could flatter: UNKNOWN outcomes count as
 * failures, a success reversed inside its window is a failure, every retry is
 * charged to the success it pursued, and a figure that cannot be computed
 * honestly is withheld with a reason rather than shown as zero.
 */

const reported = <T>(value: T): Reported<T> => ({ reported: true, value });
const notReported = <T>(reason: NotReportedReason): Reported<T> => ({ reported: false, reason });

function fail(code: LcsoInputErrorCode, message: string): never {
  throw new LcsoInputError(code, message);
}

function checkCost(amount: Nanodollars, what: string): void {
  if (amount < 0n) fail("negative-cost", `${what} is negative: ${amount}`);
}

function checkCount(value: number, code: LcsoInputErrorCode, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(code, `${what} must be a safe integer >= 0, got ${value}`);
  }
}

function checkTime(value: number | undefined, what: string): void {
  if (value !== undefined && !Number.isFinite(value)) fail("invalid-timestamp", `${what} is not a finite time: ${value}`);
}

function checkOneOf<T extends string>(allowed: readonly T[], value: string, what: string): void {
  if (!(allowed as readonly string[]).includes(value)) fail("invalid-value", `${what} is not one of ${allowed.join(", ")}: ${value}`);
}

/** Checks shared by both modes: costs, human time and the baseline. */
function validateCommon(input: LcsoCommonInput): void {
  checkCount(input.successDefinition.maturationWindowMs, "invalid-maturation-window", "maturation window (ms)");
  for (const line of input.toolCosts ?? []) checkCost(line.amount, `tool cost ${line.ref}`);
  for (const line of input.fixedCosts ?? []) checkCost(line.amount, `fixed cost ${line.ref}`);

  for (const entry of input.human?.entries ?? []) {
    checkOneOf(HUMAN_ACTIVITIES, entry.activity, "human-time activity");
    checkOneOf(COST_BASES, entry.basis, "human-time basis");
    checkCost(entry.hourlyRate, `hourly rate for ${entry.activity}`);
    checkCount(entry.minutes, "invalid-minutes", `minutes of ${entry.activity}`);
    if (entry.taskCount !== undefined) {
      checkCount(entry.taskCount, "invalid-count", `task count of ${entry.activity}`);
      if (entry.taskId !== undefined) {
        fail("invalid-count", `entry for task ${entry.taskId} also has a task count`);
      }
    }
    // Without a count, aggregate rework could not lower autonomy, which would flatter it.
    const aggregateRework = entry.activity === "rework" && entry.taskId === undefined;
    if (input.human?.reworkTracked && aggregateRework && entry.taskCount === undefined) {
      fail("invalid-count", "an aggregate rework entry must say how many tasks it covers");
    }
  }
  const baseline = input.humanBaseline;
  if (baseline && baseline.costPerOutcome <= 0n) {
    fail("invalid-baseline", `human baseline must be positive, got ${baseline.costPerOutcome}`);
  }
}

function validateTasks(input: LcsoInput): void {
  checkTime(input.asOf, "asOf");
  const taskIds = new Set<string>();
  const runIds = new Set<string>();
  for (const task of input.tasks) {
    const id = task.taskId;
    if (taskIds.has(id)) fail("duplicate-task-id", `task ${id} appears twice`);
    taskIds.add(id);
    checkOneOf(OUTCOME_STATES, task.state, `state of task ${id}`);
    if (task.evidenceTier !== undefined) checkOneOf(EVIDENCE_TIERS, task.evidenceTier, `evidence tier of task ${id}`);
    checkTime(task.resolvedAt, `resolvedAt of task ${id}`);
    checkTime(task.reversedAt, `reversedAt of task ${id}`);

    for (const run of task.runs) {
      if (runIds.has(run.runId)) fail("duplicate-run-id", `run ${run.runId} appears twice`);
      runIds.add(run.runId);
      checkCost(run.cost, `run ${run.runId}`);
      checkTime(run.startedAt, `startedAt of run ${run.runId}`);
    }
    if (task.finalRunId !== undefined && !task.runs.some((run) => run.runId === task.finalRunId)) {
      fail("unknown-final-run", `task ${id} names final run ${task.finalRunId}, which it lacks`);
    }
    if (task.state === "SUCCESS" && task.resolvedAt === undefined) {
      fail("missing-resolved-at", `SUCCESS task ${id} has no resolvedAt`);
    }
    if (task.reversedAt !== undefined) {
      if (task.state !== "SUCCESS") {
        fail("reversal-on-non-success", `task ${id} is ${task.state}; only a SUCCESS is reversed`);
      }
      if (task.reversedAt < task.resolvedAt!) {
        fail("reversal-before-resolution", `task ${id} was reversed before it resolved`);
      }
      if (task.reversedAt > input.asOf) {
        fail("reversal-in-future", `task ${id} is reversed after asOf`);
      }
    }
  }
  for (const entry of input.human?.entries ?? []) {
    if (entry.taskId !== undefined && !taskIds.has(entry.taskId)) {
      fail("unknown-task-id", `human-time entry names task ${entry.taskId}, not in the input`);
    }
  }
}

/**
 * A task's total model cost and the cost of the run that produced its outcome:
 * the one named, else the last by (startedAt, runId). One pass over the runs.
 */
function taskCosts(task: LcsoTask): { cost: Nanodollars; finalCost: Nanodollars } {
  let cost = 0n;
  let last: LcsoRun | undefined;
  for (const run of task.runs) {
    cost += run.cost;
    const later =
      task.finalRunId !== undefined
        ? run.runId === task.finalRunId
        : !last || run.startedAt > last.startedAt || (run.startedAt === last.startedAt && run.runId > last.runId);
    if (later) last = run;
  }
  return { cost, finalCost: last?.cost ?? 0n };
}

const perHour = (exact: bigint): Nanodollars => mulDiv(exact, 1n, 60n);

/**
 * C_human. Rate × minutes is summed exactly per activity and basis, then each
 * of the six buckets is divided by 60 once, so the rounding cannot compound
 * across entries. Entries for pending tasks are carried forward.
 */
function humanCost(
  input: LcsoCommonInput,
  pending: ReadonlySet<string>,
): { human: HumanComponent; carried: Nanodollars } {
  const exact = Object.fromEntries(
    HUMAN_ACTIVITIES.map((activity) => [activity, { measured: 0n, estimated: 0n }]),
  ) as Record<HumanActivity, Record<CostBasis, bigint>>;
  const minutes = { measured: 0, estimated: 0 };
  let carriedExact = 0n;
  for (const entry of input.human?.entries ?? []) {
    const amount = entry.hourlyRate * BigInt(entry.minutes);
    if (entry.taskId !== undefined && pending.has(entry.taskId)) {
      carriedExact += amount;
      continue;
    }
    exact[entry.activity][entry.basis] += amount;
    minutes[entry.basis] += entry.minutes;
  }

  const byActivity = Object.fromEntries(
    HUMAN_ACTIVITIES.map((activity) => [
      activity,
      { measured: perHour(exact[activity].measured), estimated: perHour(exact[activity].estimated) },
    ]),
  ) as HumanBuckets;
  const buckets = Object.values(byActivity);
  const measured = sumNano(buckets.map((bucket) => bucket.measured));
  const estimated = sumNano(buckets.map((bucket) => bucket.estimated));
  return {
    human: { measured, estimated, total: measured + estimated, minutes, byActivity },
    carried: perHour(carriedExact),
  };
}

/**
 * Successes that needed rework: distinct per-task entries plus the counts of
 * aggregate ones. Without a set of successes (aggregate mode) every per-task
 * entry is taken to be of a success.
 */
function reworkedCount(input: LcsoCommonInput, successes?: ReadonlySet<string>): number {
  const tasks = new Set<string>();
  let aggregate = 0;
  for (const entry of input.human?.entries ?? []) {
    if (entry.activity !== "rework") continue;
    if (entry.taskId === undefined) aggregate += entry.taskCount ?? 0;
    else if (!successes || successes.has(entry.taskId)) tasks.add(entry.taskId);
  }
  return tasks.size + aggregate;
}

interface Levels {
  readonly components: Pick<LcsoResult["components"], "tools" | "human" | "fixed">;
  readonly carriedHuman: Nanodollars;
  readonly lcso: LcsoResult["lcso"];
  readonly autonomy: Reported<Ratio>;
  readonly her: LcsoResult["her"];
  readonly flags: readonly LcsoFlag[];
}

const NO_TASKS: ReadonlySet<string> = new Set();

/** The three LCSO layers, autonomy and HER: identical in both modes. */
function levels(
  input: LcsoCommonInput,
  model: Nanodollars,
  success: number,
  pending: ReadonlySet<string> = NO_TASKS,
  successes?: ReadonlySet<string>,
): Levels {
  const tools = sumNano((input.toolCosts ?? []).map((line) => line.amount));
  const fixedLines = input.fixedCosts ?? [];
  const keys = fixedLines.flatMap((line) => (line.allocationKey === undefined ? [] : [line.allocationKey]));
  const fixed = {
    total: sumNano(fixedLines.map((line) => line.amount)),
    allocationKeys: [...new Set(keys)].sort(),
  };
  const { human, carried } = humanCost(input, pending);
  const flags: LcsoFlag[] = human.estimated > 0n ? ["human-cost-estimated"] : [];

  const tracked = input.human?.reworkTracked === true;
  // Rework only feeds autonomy, so it is only checked when autonomy is reported.
  const reworked = tracked ? reworkedCount(input, successes) : 0;
  if (reworked > success) {
    fail("rework-exceeds-successes", `${reworked} successes reworked, but only ${success} successes`);
  }

  const l1 = model;
  const l2 = l1 + tools + human.total;
  const l3 = l2 + fixed.total;
  const components = { tools, human, fixed };
  const baseline = input.humanBaseline;

  if (success === 0) {
    if (l3 > 0n) flags.push("spend-but-no-successes");
    const none = notReported<Ratio>("no-successes");
    return {
      components,
      carriedHuman: carried,
      lcso: { lcso1: none, lcso2: none, lcso3: none },
      autonomy: tracked ? none : notReported("rework-not-tracked"),
      her: notReported(baseline ? "no-successes" : "no-human-baseline"),
      flags,
    };
  }
  const n = BigInt(success);
  return {
    components,
    carriedHuman: carried,
    lcso: { lcso1: reported(ratio(l1, n)), lcso2: reported(ratio(l2, n)), lcso3: reported(ratio(l3, n)) },
    autonomy: tracked ? reported(ratio(BigInt(success - reworked), n)) : notReported("rework-not-tracked"),
    her: baseline
      ? reported({ ratio: ratio(l3, n * baseline.costPerOutcome), baseline })
      : notReported("no-human-baseline"),
    flags,
  };
}

/** §7.4, over the per-task C_model of resolved tasks. Sorts `costs` in place. */
function spreadOf(costs: Nanodollars[], model: Nanodollars): Reported<LcsoSpread> {
  if (costs.length === 0) return notReported("no-resolved-tasks");
  const sorted = costs.sort(compareBigint);
  const p50 = nearestRank(sorted, 50, 100);
  const p90 = nearestRank(sorted, 90, 100);
  const p99 = nearestRank(sorted, 99, 100);
  const tailTaskCount = nearestRankIndex(sorted.length, 5, 100) + 1;
  let tail = 0n;
  for (let i = sorted.length - tailTaskCount; i < sorted.length; i++) tail += sorted[i]!;
  return reported({
    p50,
    p90,
    p99,
    spreadRatio: p50 === 0n ? notReported("zero-median") : reported(ratio(p90, p50)),
    tailShare: model === 0n ? notReported("zero-model-cost") : reported(ratio(tail, model)),
    tailTaskCount,
  });
}

const orderedFlags = (flags: Set<LcsoFlag>): LcsoFlag[] => LCSO_FLAGS.filter((flag) => flags.has(flag));

/** The fields every result opens with, whichever mode produced it. */
function header(input: LcsoCommonInput) {
  return {
    methodologyVersion: LCSO_METHODOLOGY_VERSION,
    workflowId: input.workflowId,
    period: { from: input.period.from, to: input.period.to },
    successDefinition: { id: input.successDefinition.id, version: input.successDefinition.version },
  };
}

const FAILED_COUNTER = { FAILURE: "failure", ABANDONED: "abandoned", UNKNOWN: "unknown" } as const;

/** Validates an optional count; a missing one counts as zero. */
function optionalCount(value: number | undefined, what: string): number {
  if (value === undefined) return 0;
  checkCount(value, "invalid-count", what);
  return value;
}

const share = (part: number, whole: number, reason: NotReportedReason): Reported<Ratio> =>
  whole === 0 ? notReported(reason) : reported(ratio(BigInt(part), BigInt(whole)));

/** The full method, from per-task outcomes and runs. */
export function computeLcso(input: LcsoInput): LcsoResult {
  validateCommon(input);
  validateTasks(input);

  const window = input.successDefinition.maturationWindowMs;
  const counts = {
    success: 0,
    failure: 0,
    abandoned: 0,
    unknown: 0,
    pending: 0,
    pendingMaturing: 0,
    clawedBack: 0,
    withoutRuns: 0,
  };
  const evidenceTiers = { A: 0, B: 0, C: 0, none: 0 };
  const pendingIds = new Set<string>();
  const successIds = new Set<string>();
  const resolvedCosts: Nanodollars[] = [];
  const adjustments: { taskId: string; reversedAt: number }[] = [];
  let model = 0n;
  let nonFinal = 0n;
  let failedCost = 0n;
  let carriedModel = 0n;

  for (const task of input.tasks) {
    const { cost, finalCost } = taskCosts(task);

    let state = task.state;
    if (state === "SUCCESS") {
      const end = task.resolvedAt! + window;
      if (task.reversedAt !== undefined && task.reversedAt <= end) {
        state = "FAILURE";
        counts.clawedBack++;
      } else if (input.asOf < end) {
        state = "PENDING";
        counts.pendingMaturing++;
      } else if (task.reversedAt !== undefined) {
        adjustments.push({ taskId: task.taskId, reversedAt: task.reversedAt });
      }
    }

    if (state === "PENDING") {
      counts.pending++;
      pendingIds.add(task.taskId);
      carriedModel += cost;
      continue;
    }

    if (task.runs.length === 0) counts.withoutRuns++;
    model += cost;
    resolvedCosts.push(cost);
    evidenceTiers[task.evidenceTier ?? "none"]++;
    if (state === "SUCCESS") {
      counts.success++;
      successIds.add(task.taskId);
      nonFinal += cost - finalCost;
    } else {
      counts[FAILED_COUNTER[state]]++;
      failedCost += cost;
    }
  }

  const resolved = counts.success + counts.failure + counts.abandoned + counts.unknown;
  const flags = new Set<LcsoFlag>();
  if (resolved === 0) flags.add("no-resolved-tasks");
  if (counts.unknown > 0) flags.add("unknown-outcomes-present");
  if (evidenceTiers.C * 2 > resolved) flags.add("mostly-tier-c");
  if (adjustments.length > 0) flags.add("prior-period-adjustment");
  if (counts.withoutRuns > 0) flags.add("tasks-without-runs");

  const shared = levels(input, model, counts.success, pendingIds, successIds);
  for (const flag of shared.flags) flags.add(flag);
  adjustments.sort((a, b) => a.reversedAt - b.reversedAt || (a.taskId < b.taskId ? -1 : 1));

  return {
    ...header(input),
    mode: "per-task",
    asOf: input.asOf,
    counts: { resolved, ...counts },
    evidenceTiers,
    components: { model, modelNonFinalSuccessRuns: nonFinal, ...shared.components },
    carriedForward: { tasks: counts.pending, model: carriedModel, human: shared.carriedHuman },
    lcso: shared.lcso,
    failureCostShare:
      model === 0n ? notReported("zero-model-cost") : reported(ratio(failedCost + nonFinal, model)),
    spread: spreadOf(resolvedCosts, model),
    rates: {
      success: share(counts.success, resolved, "no-resolved-tasks"),
      clawback: share(counts.clawedBack, counts.success + counts.clawedBack, "no-successes"),
      autonomy: shared.autonomy,
    },
    her: shared.her,
    flags: orderedFlags(flags),
    priorPeriodAdjustments: adjustments,
  };
}

/**
 * Levels, success rate and HER from totals alone. The model cost cannot be
 * split by outcome, so it may include spend on tasks not yet resolved; the
 * result always says so.
 */
export function computeLcsoAggregate(input: LcsoAggregateInput): LcsoResult {
  validateCommon(input);
  checkCost(input.modelCost, "model cost");
  checkCount(input.successCount, "invalid-count", "success count");
  const success = input.successCount;
  const failure = optionalCount(input.failureCount, "failure count");
  const abandoned = optionalCount(input.abandonedCount, "abandoned count");
  const unknown = optionalCount(input.unknownCount, "unknown count");
  const resolved = success + failure + abandoned + unknown;
  const allCounts =
    input.failureCount !== undefined && input.abandonedCount !== undefined && input.unknownCount !== undefined;

  const flags = new Set<LcsoFlag>(["aggregate-includes-unresolved-spend"]);
  if (unknown > 0) flags.add("unknown-outcomes-present");
  if (!allCounts) flags.add("failure-counts-not-supplied");
  // No tasks: nothing is pending, and every rework entry is taken to be of a success.
  const shared = levels(input, input.modelCost, success);
  for (const flag of shared.flags) flags.add(flag);

  return {
    ...header(input),
    mode: "aggregate",
    asOf: null,
    counts: { resolved, success, failure, abandoned, unknown, pending: 0, pendingMaturing: 0, clawedBack: 0, withoutRuns: 0 },
    evidenceTiers: { A: 0, B: 0, C: 0, none: 0 },
    components: { model: input.modelCost, modelNonFinalSuccessRuns: 0n, ...shared.components },
    carriedForward: { tasks: 0, model: 0n, human: shared.carriedHuman },
    lcso: shared.lcso,
    failureCostShare: notReported("aggregate-mode"),
    spread: notReported("aggregate-mode"),
    rates: {
      success: allCounts ? share(success, resolved, "no-resolved-tasks") : notReported("counts-not-supplied"),
      clawback: notReported("aggregate-mode"),
      autonomy: shared.autonomy,
    },
    her: shared.her,
    flags: orderedFlags(flags),
    priorPeriodAdjustments: [],
  };
}

/**
 * §10. Bands by cross-multiplication, so exactly 98% and exactly 90% fall in
 * the higher band with no float in between. Observing more than was billed
 * cannot hide spend, so it is complete, but flagged for investigation.
 */
export function coverage(observed: Nanodollars, billed: Nanodollars): Coverage {
  checkCost(observed, "observed spend");
  checkCost(billed, "billed spend");
  if (billed === 0n) {
    return observed === 0n
      ? { ratio: null, band: "complete", unattributed: 0n, observedExceedsBilled: false }
      : { ratio: null, band: "withheld", unattributed: 0n, observedExceedsBilled: true };
  }
  const r = ratio(observed, billed);
  const atLeast = (percent: bigint) => compareRatio(r, ratio(percent, 100n)) >= 0;
  return {
    ratio: r,
    band: atLeast(98n) ? "complete" : atLeast(90n) ? "disclosed" : "withheld",
    unattributed: observed < billed ? billed - observed : 0n,
    observedExceedsBilled: observed > billed,
  };
}
