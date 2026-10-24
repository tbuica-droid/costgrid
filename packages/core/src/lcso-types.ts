import type { Nanodollars } from "./money.js";
import type { Ratio } from "./ratio.js";

/**
 * Inputs and outputs of the LCSO engine (`lcso.ts`), following the
 * Levelized Cost per Successful Outcome methodology, v0.1.
 *
 * Every input is metadata: identifiers, timestamps, charges, outcome states
 * and time records. Times are epoch milliseconds. Money is nanodollars.
 */

export const LCSO_METHODOLOGY_VERSION = "0.1" as const;

/** §5.1. Exactly one per task. */
export const OUTCOME_STATES = ["SUCCESS", "FAILURE", "ABANDONED", "PENDING", "UNKNOWN"] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

/** §5.4. A: system of record. B: asserted through the outcome API. C: inferred from behaviour. */
export const EVIDENCE_TIERS = ["A", "B", "C"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

export const HUMAN_ACTIVITIES = ["review", "rework", "handoff"] as const;
export type HumanActivity = (typeof HUMAN_ACTIVITIES)[number];

/** Time records are `measured`; a time study is `estimated`. Never blended silently. */
export const COST_BASES = ["measured", "estimated"] as const;
export type CostBasis = (typeof COST_BASES)[number];

/** §5.2. Figures under different versions must not be compared. */
export interface SuccessDefinitionRef {
  readonly id: string;
  readonly version: string;
  /** How long a SUCCESS must stand before it counts (§5.3). */
  readonly maturationWindowMs: number;
}

/** One attempt by the AI system at a task: a retry, re-run or sub-agent. */
export interface LcsoRun {
  readonly runId: string;
  /** All model charges of the run's calls. */
  readonly cost: Nanodollars;
  readonly startedAt: number;
}

/** One business item the workflow tries to complete. Success is counted per task. */
export interface LcsoTask {
  readonly taskId: string;
  readonly state: OutcomeState;
  readonly evidenceTier?: EvidenceTier;
  /** When the task reached its state. Required for SUCCESS. */
  readonly resolvedAt?: number;
  readonly runs: readonly LcsoRun[];
  /** The run that produced the outcome. Default: the last by (startedAt, runId). */
  readonly finalRunId?: string;
  /** A SUCCESS later reversed: a ticket reopened, a pull request reverted. */
  readonly reversedAt?: number;
}

/**
 * Human time caused by the AI system (§6, C_human). Either for one task, or
 * an aggregate from a time study covering `taskCount` tasks.
 */
export interface HumanTimeEntry {
  readonly activity: HumanActivity;
  /** Whole minutes, a safe integer >= 0. */
  readonly minutes: number;
  /** Fully loaded cost of one hour. */
  readonly hourlyRate: Nanodollars;
  readonly basis: CostBasis;
  readonly taskId?: string;
  /**
   * For an aggregate entry: how many tasks it covers. Required on aggregate
   * rework when rework is tracked, since it lowers the autonomy rate.
   */
  readonly taskCount?: number;
}

/** A tool charge (C_tools) or a fixed cost (C_fixed) with its ledger reference. */
export interface CostLine {
  readonly ref: string;
  readonly amount: Nanodollars;
  /** How a shared cost was allocated to this workflow (§8 rule 4). */
  readonly allocationKey?: string;
}

/** The fully loaded human cost per outcome of the same work, with its provenance (§7.5). */
export interface HumanBaseline {
  readonly costPerOutcome: Nanodollars;
  readonly source: string;
  readonly date: string;
  readonly method: string;
}

export interface LcsoCommonInput {
  readonly workflowId: string;
  readonly period: { readonly from: number; readonly to: number };
  readonly successDefinition: SuccessDefinitionRef;
  readonly toolCosts?: readonly CostLine[];
  readonly fixedCosts?: readonly CostLine[];
  readonly human?: {
    readonly entries: readonly HumanTimeEntry[];
    /** Whether every rework of a success was recorded. Without it, autonomy is not reported. */
    readonly reworkTracked: boolean;
  };
  readonly humanBaseline?: HumanBaseline;
}

/**
 * Per-task input: the full method. The caller selects the tasks that resolved
 * in the period, plus the tasks still pending, with all their runs regardless
 * of when each run happened (§8 rule 5: costs follow their task).
 */
export interface LcsoInput extends LcsoCommonInput {
  /** The moment the figures are computed as of; decides which successes have matured. */
  readonly asOf: number;
  readonly tasks: readonly LcsoTask[];
}

/**
 * Totals-only input, for a workflow that reports outcome counts but not
 * per-task costs. Levels, success rate and HER only; the rest needs tasks.
 */
export interface LcsoAggregateInput extends LcsoCommonInput {
  readonly modelCost: Nanodollars;
  readonly successCount: number;
  readonly failureCount?: number;
  readonly abandonedCount?: number;
  readonly unknownCount?: number;
}

export type NotReportedReason =
  | "no-successes"
  | "zero-model-cost"
  | "zero-median"
  | "no-resolved-tasks"
  | "aggregate-mode"
  | "no-human-baseline"
  | "rework-not-tracked"
  | "counts-not-supplied";

/** A figure, or the reason it is withheld. Never a misleading zero. */
export type Reported<T> =
  | { readonly reported: true; readonly value: T }
  | { readonly reported: false; readonly reason: NotReportedReason };

/** Disclosures a statement must carry. Listed in this order in every result. */
export const LCSO_FLAGS = [
  "spend-but-no-successes",
  "no-resolved-tasks",
  "unknown-outcomes-present",
  "mostly-tier-c",
  "human-cost-estimated",
  "prior-period-adjustment",
  "tasks-without-runs",
  "aggregate-includes-unresolved-spend",
  "failure-counts-not-supplied",
] as const;

export type LcsoFlag = (typeof LCSO_FLAGS)[number];

export type HumanBuckets = Record<HumanActivity, Record<CostBasis, Nanodollars>>;

export interface HumanComponent {
  readonly measured: Nanodollars;
  readonly estimated: Nanodollars;
  readonly total: Nanodollars;
  readonly minutes: { readonly measured: number; readonly estimated: number };
  readonly byActivity: HumanBuckets;
}

export interface LcsoSpread {
  readonly p50: Nanodollars;
  readonly p90: Nanodollars;
  readonly p99: Nanodollars;
  /** p90 / p50. */
  readonly spreadRatio: Reported<Ratio>;
  /** Share of C_model spent by the most expensive 5% of tasks. */
  readonly tailShare: Reported<Ratio>;
  readonly tailTaskCount: number;
}

export interface LcsoCounts {
  /** success + failure + abandoned + unknown. */
  readonly resolved: number;
  readonly success: number;
  /** Includes successes clawed back inside their maturation window. */
  readonly failure: number;
  readonly abandoned: number;
  readonly unknown: number;
  /** All tasks excluded as pending, including successes still maturing. */
  readonly pending: number;
  /** The successes among `pending` whose maturation window has not passed. */
  readonly pendingMaturing: number;
  readonly clawedBack: number;
  readonly withoutRuns: number;
}

export interface LcsoResult {
  readonly methodologyVersion: typeof LCSO_METHODOLOGY_VERSION;
  readonly mode: "per-task" | "aggregate";
  readonly workflowId: string;
  readonly period: { readonly from: number; readonly to: number };
  readonly asOf: number | null;
  readonly successDefinition: { readonly id: string; readonly version: string };
  readonly counts: LcsoCounts;
  /** Of resolved tasks. */
  readonly evidenceTiers: {
    readonly A: number;
    readonly B: number;
    readonly C: number;
    readonly none: number;
  };
  readonly components: {
    readonly model: Nanodollars;
    readonly modelNonFinalSuccessRuns: Nanodollars;
    readonly tools: Nanodollars;
    readonly human: HumanComponent;
    readonly fixed: { readonly total: Nanodollars; readonly allocationKeys: readonly string[] };
  };
  /** Cost of pending tasks, reported in the period they resolve. */
  readonly carriedForward: {
    readonly tasks: number;
    readonly model: Nanodollars;
    readonly human: Nanodollars;
  };
  /** Nanodollars per success. */
  readonly lcso: {
    readonly lcso1: Reported<Ratio>;
    readonly lcso2: Reported<Ratio>;
    readonly lcso3: Reported<Ratio>;
  };
  readonly failureCostShare: Reported<Ratio>;
  readonly spread: Reported<LcsoSpread>;
  readonly rates: {
    readonly success: Reported<Ratio>;
    readonly clawback: Reported<Ratio>;
    readonly autonomy: Reported<Ratio>;
  };
  readonly her: Reported<{ readonly ratio: Ratio; readonly baseline: HumanBaseline }>;
  readonly flags: readonly LcsoFlag[];
  /** Successes reversed after their window closed: disclosed, not restated. */
  readonly priorPeriodAdjustments: readonly { readonly taskId: string; readonly reversedAt: number }[];
}

export type LcsoInputErrorCode =
  | "duplicate-task-id"
  | "duplicate-run-id"
  | "negative-cost"
  | "invalid-minutes"
  | "invalid-count"
  | "invalid-maturation-window"
  | "invalid-timestamp"
  | "invalid-value"
  | "missing-resolved-at"
  | "reversal-on-non-success"
  | "reversal-before-resolution"
  | "reversal-in-future"
  | "unknown-final-run"
  | "unknown-task-id"
  | "rework-exceeds-successes"
  | "invalid-baseline";

/** Input that would make a figure wrong rather than merely incomplete. */
export class LcsoInputError extends RangeError {
  constructor(
    readonly code: LcsoInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LcsoInputError";
  }
}

export type CoverageBand = "complete" | "disclosed" | "withheld";

/** §10. Gateway-observed spend reconciled against what the provider billed. */
export interface Coverage {
  /** observed / billed; null when nothing was billed. */
  readonly ratio: Ratio | null;
  readonly band: CoverageBand;
  /** Billed but not observed, shown as its own line. */
  readonly unattributed: Nanodollars;
  readonly observedExceedsBilled: boolean;
}
