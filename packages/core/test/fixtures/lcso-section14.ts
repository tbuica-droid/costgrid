import { usd } from "../../src/money.js";
import type {
  CostLine,
  HumanBaseline,
  HumanTimeEntry,
  LcsoAggregateInput,
  LcsoInput,
  LcsoTask,
  OutcomeState,
} from "../../src/lcso-types.js";

/**
 * The worked example of LCSO methodology v0.1, §14, as task-level input.
 *
 * The methodology gives only totals and percentiles, so this builds one
 * concrete population that reproduces every figure: seven cost bands over
 * the 9,800 resolved tasks, in ascending cost order, so that the percentile
 * ranks land where §14 says they do.
 *
 * | Band | $/task | Ranks     | SUCCESS | FAILURE | ABANDONED |
 * | A    | 0.10   | 1–3000    | 2800    | 200     | 0         |
 * | B    | 0.22   | 3001–5000 | 2000    | 0       | 0         |
 * | C    | 0.30   | 5001–8700 | 2230    | 1090    | 380       |
 * | D    | 0.71   | 8701–9000 | 300     | 0       | 0         |
 * | E    | 0.80   | 9001–9650 | 370     | 160     | 120       |
 * | F    | 2.90   | 9651–9750 | 50      | 50      | 0         |
 * | G    | 3.34   | 9751–9800 | 50      | 0       | 0         |
 *
 * Successes in E, F and G took two runs, so $330 of their spend is non-final
 * retries; failures in F took three. Then 150 tasks still PENDING and 50
 * successes still inside their 7-day window, $0.30 each, carry $60 forward.
 *
 * Deterministic: no randomness, and tasks are emitted in a fixed permuted
 * order so nothing can depend on them arriving sorted.
 */

const DAY = 86_400_000;
const MINUTE = 60_000;

export const SECTION14_FROM = Date.UTC(2026, 8, 1);
export const SECTION14_TO = Date.UTC(2026, 9, 1);
export const SECTION14_AS_OF = SECTION14_TO;
export const SECTION14_WINDOW_MS = 7 * DAY;

interface Band {
  readonly cost: string;
  readonly success: number;
  readonly failure: number;
  readonly abandoned: number;
  readonly successRuns?: readonly string[];
  readonly failureRuns?: readonly string[];
}

const BANDS: readonly Band[] = [
  { cost: "0.10", success: 2800, failure: 200, abandoned: 0 },
  { cost: "0.22", success: 2000, failure: 0, abandoned: 0 },
  { cost: "0.30", success: 2230, failure: 1090, abandoned: 380 },
  { cost: "0.71", success: 300, failure: 0, abandoned: 0 },
  { cost: "0.80", success: 370, failure: 160, abandoned: 120, successRuns: ["0.50", "0.30"] },
  {
    cost: "2.90",
    success: 50,
    failure: 50,
    abandoned: 0,
    successRuns: ["0.90", "2.00"],
    failureRuns: ["1.00", "1.00", "0.90"],
  },
  { cost: "3.34", success: 50, failure: 0, abandoned: 0, successRuns: ["2.00", "1.34"] },
];

function makeTask(
  index: number,
  state: OutcomeState,
  runCosts: readonly string[],
  resolvedAt?: number,
): LcsoTask {
  const taskId = `t${String(index).padStart(5, "0")}`;
  const anchor = resolvedAt ?? SECTION14_FROM + index * 1000;
  const runs = runCosts.map((cost, j) => ({
    runId: `${taskId}-r${j + 1}`,
    cost: usd(cost),
    startedAt: anchor - (runCosts.length - j) * MINUTE,
  }));
  const base = { taskId, state, runs };
  if (resolvedAt === undefined) return base;
  return { ...base, resolvedAt, evidenceTier: state === "SUCCESS" ? "A" : "B" };
}

function buildTasks(): LcsoTask[] {
  const tasks: LcsoTask[] = [];
  // Resolved across the first 23 days, so every success has matured by asOf.
  const resolvedAt = () => SECTION14_FROM + (tasks.length % 23) * DAY + 60 * MINUTE;
  for (const band of BANDS) {
    const groups: [OutcomeState, number, readonly string[]][] = [
      ["SUCCESS", band.success, band.successRuns ?? [band.cost]],
      ["FAILURE", band.failure, band.failureRuns ?? [band.cost]],
      ["ABANDONED", band.abandoned, [band.cost]],
    ];
    for (const [state, count, runs] of groups) {
      for (let i = 0; i < count; i++) tasks.push(makeTask(tasks.length, state, runs, resolvedAt()));
    }
  }
  for (let i = 0; i < 150; i++) tasks.push(makeTask(tasks.length, "PENDING", ["0.30"]));
  for (let i = 0; i < 50; i++) {
    tasks.push(makeTask(tasks.length, "SUCCESS", ["0.30"], SECTION14_AS_OF - 3 * DAY));
  }

  // 7919 is prime, so i -> i*7919 mod 10000 visits every task exactly once.
  return tasks.map((_, i) => tasks[(i * 7919) % tasks.length]!);
}

const rate = usd(45);

/** §14's time study: all estimated, as aggregates. */
export const SECTION14_HUMAN: readonly HumanTimeEntry[] = [
  { activity: "review", minutes: 1560, hourlyRate: rate, basis: "estimated" },
  { activity: "rework", minutes: 1872, hourlyRate: rate, basis: "estimated", taskCount: 312 },
  { activity: "handoff", minutes: 3000, hourlyRate: rate, basis: "estimated" },
];

export const SECTION14_FIXED: readonly CostLine[] = [
  { ref: "gateway-and-infrastructure", amount: usd("400"), allocationKey: "dedicated" },
  { ref: "evaluation-and-observability", amount: usd("600"), allocationKey: "dedicated" },
  { ref: "engineering-maintenance-0.25-fte", amount: usd("3000"), allocationKey: "dedicated" },
];

export const SECTION14_BASELINE: HumanBaseline = {
  costPerOutcome: usd("6.75"),
  source: "time study",
  date: "2026-06",
  method: "time study",
};

const common = {
  workflowId: "tier-1-support",
  period: { from: SECTION14_FROM, to: SECTION14_TO },
  successDefinition: { id: "closed-not-reopened", version: "1", maturationWindowMs: SECTION14_WINDOW_MS },
  fixedCosts: SECTION14_FIXED,
  human: { entries: SECTION14_HUMAN, reworkTracked: true },
  humanBaseline: SECTION14_BASELINE,
};

export function section14Input(): LcsoInput {
  return { ...common, asOf: SECTION14_AS_OF, tasks: buildTasks() };
}

export function section14AggregateInput(): LcsoAggregateInput {
  return { ...common, modelCost: usd("3040"), successCount: 7800 };
}
