import {
  formatPercent,
  formatRatio,
  formatUsdPerOutcome,
  LCSO_METHODOLOGY_VERSION,
  type LcsoResult,
  type Nanodollars,
  type Ratio,
  toUsdString,
  verdictOf,
  type VerdictKind,
} from "@costgrid/core";
import type { RunOutcomes } from "./run-outcomes.js";

/**
 * The statement's "did the jobs get done" section: per agent, for the month,
 * what CostGrid concluded and what a finished job cost (LCSO-1).
 *
 * Every figure here is indicative and the statement says so; `basis` says
 * where the outcome counts came from, so a reader never mistakes an inference
 * for a report. Kept out of `statement.ts` for length.
 */

export type JobsBasis = "inferred" | "reported" | "mixed" | "owner-count";

export interface StatementJobRow {
  readonly agentId: string;
  readonly name: string | null;
  readonly basis: JobsBasis;
  readonly finished: number;
  /** Failed, stopped by a limit, or couldn't be told: the method counts them all as not finished. */
  readonly notFinished: number;
  readonly waiting: number;
  readonly cost: Nanodollars;
  readonly costPerFinished: Ratio | undefined;
  readonly failureShare: Ratio | undefined;
  /** AI cost per finished job over the owner's person estimate. */
  readonly personRatio: Ratio | undefined;
  readonly verdict: VerdictKind;
}

export interface StatementJobs {
  readonly methodologyVersion: string;
  readonly rows: readonly StatementJobRow[];
  /** Agents with traffic that were not judged: their purpose predates automatic detection. */
  readonly notJudged: readonly { readonly agentId: string; readonly name: string | null }[];
}

function row(agentId: string, name: string | null, basis: JobsBasis, r: LcsoResult, cost: Nanodollars): StatementJobRow {
  const c = r.counts;
  return {
    agentId,
    name,
    basis,
    finished: c.success,
    notFinished: c.failure + c.abandoned + c.unknown,
    waiting: c.pending,
    cost,
    costPerFinished: r.lcso.lcso1.reported ? r.lcso.lcso1.value : undefined,
    failureShare: r.failureCostShare.reported ? r.failureCostShare.value : undefined,
    personRatio: r.her.reported ? r.her.value.ratio : undefined,
    verdict: verdictOf(r),
  };
}

function basisOf(r: LcsoResult): JobsBasis {
  const { B, C, none } = r.evidenceTiers;
  if (B === 0) return "inferred";
  return C + none === 0 ? "reported" : "mixed";
}

/** The month's jobs per agent. `range` is the statement's month; `now` decides which jobs are still waiting. */
export function statementJobs(
  outcomes: RunOutcomes,
  tenantId: string,
  month: string,
  range: { from: number; to: number },
  now: number,
): StatementJobs {
  // Judged as of now, not as of the month's end: a job that finished on the
  // 30th has matured since, and runs after the month show if it was asked again.
  const report = outcomes.forTenant(tenantId, range, now, { followUntil: now, month });
  const rows: StatementJobRow[] = [];
  const notJudged: { agentId: string; name: string | null }[] = [];
  for (const a of report.agents) {
    if (a.result) rows.push(row(a.agentId, a.name, basisOf(a.result), a.result, a.totalCost));
    else notJudged.push({ agentId: a.agentId, name: a.name });
  }
  for (const a of report.noOutcomeData) {
    if (a.latest?.month === month) rows.push(row(a.id, a.name, "owner-count", a.latest.result, a.latest.cost));
  }
  return { methodologyVersion: LCSO_METHODOLOGY_VERSION, rows, notJudged };
}

/** Each verdict as a short line for a printed statement. The console writes fuller sentences. */
export const VERDICT_LINES: Readonly<Record<VerdictKind, string>> = {
  "no-data": "Nothing to judge yet.",
  "spend-no-successes": "Money spent and no job finished.",
  "too-early": "Too early to say: jobs still in their waiting period.",
  "dearer-than-person": "A finished job costs more than your estimate for a person.",
  "mostly-failures": "Most of the money goes on jobs that don't finish.",
  "unpredictable": "A bad job costs 3× or more a typical one.",
  steady: "Steady cost per finished job.",
};

export const BASIS_LABELS: Readonly<Record<JobsBasis, string>> = {
  inferred: "inferred from behaviour",
  reported: "reported by your software",
  mixed: "reported and inferred",
  "owner-count": "your count",
};

/** The section as JSON, money as decimal strings; null without one. Every figure indicative. */
export function jobsView(jobs: StatementJobs | undefined) {
  if (jobs === undefined) return null;
  return {
    indicative: true,
    methodologyVersion: jobs.methodologyVersion,
    notJudged: jobs.notJudged,
    agents: jobs.rows.map((r) => ({
      agentId: r.agentId,
      name: r.name,
      basis: r.basis,
      finished: r.finished,
      notFinished: r.notFinished,
      stillWaiting: r.waiting,
      spendUsd: toUsdString(r.cost, 6),
      costPerFinishedUsd: r.costPerFinished === undefined ? null : formatUsdPerOutcome(r.costPerFinished, 6),
      spendOnUnfinishedPct: r.failureShare === undefined ? null : formatPercent(r.failureShare, 1),
      aiCostVsPerson: r.personRatio === undefined ? null : formatRatio(r.personRatio, 2),
      verdict: r.verdict,
    })),
  };
}

/** The section as CSV lines, headed so a spreadsheet reader sees the figures are indicative. */
export function jobsCsvRows(jobs: StatementJobs, csvRow: (fields: readonly (string | number)[]) => string): string[] {
  if (jobs.rows.length === 0 && jobs.notJudged.length === 0) return [];
  return [
    "",
    csvRow([`jobs (indicative; cost per finished job, LCSO method v${jobs.methodologyVersion})`]),
    csvRow([
      "agent",
      "agent_id",
      "basis",
      "finished",
      "not_finished",
      "still_waiting",
      "spend_usd",
      "cost_per_finished_usd",
      "spend_on_unfinished_pct",
      "ai_cost_vs_person",
      "verdict",
    ]),
    ...jobs.rows.map((r) =>
      csvRow([
        r.name ?? r.agentId,
        r.agentId,
        r.basis,
        r.finished,
        r.notFinished,
        r.waiting,
        toUsdString(r.cost, 6),
        r.costPerFinished === undefined ? "" : formatUsdPerOutcome(r.costPerFinished, 6),
        r.failureShare === undefined ? "" : formatPercent(r.failureShare, 1),
        r.personRatio === undefined ? "" : formatRatio(r.personRatio, 2),
        r.verdict,
      ]),
    ),
    ...jobs.notJudged.map((a) => csvRow([a.name ?? a.agentId, a.agentId, "not judged: its purpose predates automatic detection"])),
  ];
}
