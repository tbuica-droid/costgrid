import {
  type AdjustmentKind,
  effortRank,
  isReasoningEffort,
  type Nanodollars,
  type Policy,
  type PolicyScope,
} from "@costgrid/core";
import type { Db } from "./database.js";
import { MEASURE_BASELINE_DAYS, MIN_CALLS_PER_SIDE } from "./measured.js";
import { RunOutcomes } from "./run-outcomes.js";

/**
 * Did lowering reasoning, or adding cache breakpoints, actually pay?
 *
 * Measured the same way as a model switch (`measured.ts`): the scope's
 * matching calls in the fortnight before the rule went live, against the
 * calls the rule changed since. For an agent-scoped rule it also compares cost
 * per finished job and the share of jobs finished, because a cheaper call that
 * finishes fewer jobs is not a saving.
 *
 * "Matching" means what the rule would have changed:
 *   - lower-reasoning: calls that asked for more effort, or a bigger thinking
 *     budget, than the rule allows;
 *   - add-cache: Claude-format calls that used no caching at all.
 *
 * Not a controlled experiment, and every result says so.
 */

/** Jobs a side needs before "fewer jobs finished" is judged. */
export const MIN_JOBS_PER_SIDE = 20;
/** How far the finished share may fall, in points, before it counts as worse. */
export const FINISHED_SHARE_TOLERANCE = 0.05;
/**
 * Failed calls after the change before a rise in failures is judged. Small on
 * purpose: a level the model rejects fails every call, and waiting for thirty
 * would leave an agent broken for longer than any saving is worth.
 */
export const MIN_ERRORS_TO_JUDGE = 5;
/** How far the share of failed calls may rise, in points, before it counts as worse. */
export const ERROR_RATE_TOLERANCE = 0.05;

const DAY_MS = 86_400_000;

/** Calls that went through and calls that failed, with cost and tokens from the first only. */
const SUMS = `COALESCE(SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END), 0) AS calls,
  COALESCE(SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END), 0) AS errors,
  COALESCE(SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END), 0) AS cost,
  COALESCE(SUM(CASE WHEN outcome = 'ok' THEN cost_input + cost_cache_write + cost_cache_read ELSE 0 END), 0) AS input,
  COALESCE(SUM(CASE WHEN outcome = 'ok' THEN output_tokens ELSE 0 END), 0) AS output`;
const CLAUDE_FORMAT = "('anthropic', 'bedrock', 'vertex')";

export interface QuickWinCohort {
  /** Calls that went through. Failed calls are counted in `errors`, not here. */
  readonly calls: number;
  readonly errors: number;
  /** Failed calls over all calls; null with none. */
  readonly errorRate: number | null;
  readonly costPerCall: Nanodollars | null;
  /** Input, cache-write and cache-read cost per call: the part caching changes. */
  readonly inputCostPerCall: Nanodollars | null;
  readonly outputTokensPerCall: number | null;
}

export interface JobsCohort {
  /** Jobs resolved in the period, finished or not. */
  readonly jobs: number;
  readonly finished: number;
  readonly finishedShare: number | null;
  readonly costPerFinishedJob: Nanodollars | null;
}

export type QuickWinVerdict =
  | "more-errors"
  | "cheaper"
  | "more-expensive"
  | "no-change"
  | "fewer-jobs-finished"
  | "not-enough-data";

export interface QuickWinMeasurement {
  readonly policyId: string;
  readonly policyName: string;
  readonly kind: AdjustmentKind;
  readonly scope: PolicyScope;
  readonly action: Policy["action"];
  readonly enabled: boolean;
  readonly liveSince: number;
  readonly before: QuickWinCohort;
  readonly after: QuickWinCohort;
  /** After against before, per call: -0.3 is 30% cheaper. Null below the minimum sample. */
  readonly changePerCall: number | null;
  /** Agent-scoped rules only, when asked for. */
  readonly jobs?: {
    readonly before: JobsCohort;
    readonly after: JobsCohort;
    readonly changePerFinishedJob: number | null;
  };
  readonly verdict: QuickWinVerdict;
  readonly caveat: string;
}

const CAVEAT =
  "Before and after on your own traffic, not a controlled experiment. If the work changed " +
  "when the rule went live, part of this difference is that.";

type MeasurablePolicy = Policy & { liveSince: number | null; createdAt: number };

function scopeFilter(scope: PolicyScope): { sql: string; params: string[] } {
  if (scope.kind === "agent") return { sql: " AND agent_id = ?", params: [scope.agentId] };
  if (scope.kind === "department") return { sql: " AND department = ?", params: [scope.department] };
  return { sql: "", params: [] };
}

function change(before: bigint | null, after: bigint | null): number | null {
  if (before === null || after === null || before === 0n) return null;
  return Number(after - before) / Number(before);
}

interface Sums {
  calls: bigint;
  errors: bigint;
  cost: bigint;
  input: bigint;
  output: bigint;
}

function cohort(s: Sums): QuickWinCohort {
  const n = Number(s.calls);
  const errors = Number(s.errors);
  return {
    calls: n,
    errors,
    errorRate: n + errors === 0 ? null : errors / (n + errors),
    costPerCall: n === 0 ? null : s.cost / BigInt(n),
    inputCostPerCall: n === 0 ? null : s.input / BigInt(n),
    outputTokensPerCall: n === 0 ? null : Math.round(Number(s.output) / n),
  };
}

/** Would a lower-reasoning rule have changed a call that asked for this? */
export function exceedsReasoning(
  requested: string,
  rule: { effort?: string | undefined; budgetTokens?: number | undefined },
): boolean {
  for (const part of requested.split(" ")) {
    const [key, value] = part.split(":");
    if (key === "effort" && rule.effort !== undefined && isReasoningEffort(value) && isReasoningEffort(rule.effort)) {
      if (effortRank(value) > effortRank(rule.effort)) return true;
    }
    if (key === "budget" && rule.budgetTokens !== undefined && Number(value) > Math.max(rule.budgetTokens, 1024)) {
      return true;
    }
  }
  return false;
}

export class QuickWins {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * One measurement per adjustment rule that has been switched on at least
   * once. `jobs` adds the cost-per-finished-job comparison, which reads every
   * run in both periods: run it off the request thread.
   */
  measure(
    tenantId: string,
    policies: readonly MeasurablePolicy[],
    now: number,
    opts: { jobs?: boolean } = {},
  ): QuickWinMeasurement[] {
    const out: QuickWinMeasurement[] = [];
    for (const policy of policies) {
      const kind = policy.rule.kind;
      if (kind !== "lower-reasoning" && kind !== "add-cache") continue;
      // A rule never switched on has no after-period to measure.
      if (policy.liveSince === null && policy.action === "monitor") continue;
      out.push(this.#one(tenantId, policy, policy.liveSince ?? policy.createdAt, now, opts.jobs === true));
    }
    return out;
  }

  #sums(where: string, params: unknown[]): Sums {
    return this.#db
      .prepare(
        `SELECT ${SUMS}
         FROM calls WHERE outcome IN ('ok', 'error') ${where}`,
      )
      .safeIntegers(true)
      .get(...params) as unknown as Sums;
  }

  #before(tenantId: string, policy: MeasurablePolicy, from: number, to: number): Sums {
    const scope = scopeFilter(policy.scope);
    const base = `AND tenant_id = ? AND started_at >= ? AND started_at < ?${scope.sql}`;
    const params = [tenantId, from, to, ...scope.params];
    const rule = policy.rule;

    if (rule.kind === "add-cache") {
      return this.#sums(
        `${base} AND provider IN ${CLAUDE_FORMAT}
         AND cache_read_tokens = 0 AND cache_write_5m_tokens = 0 AND cache_write_1h_tokens = 0`,
        params,
      );
    }

    // What each call asked for is a short label with few distinct values, so
    // sum by label and keep the ones the rule would have lowered.
    const groups = this.#db
      .prepare(
        `SELECT reasoning_requested AS requested, ${SUMS}
         FROM calls WHERE outcome IN ('ok', 'error') AND reasoning_requested IS NOT NULL ${base}
         GROUP BY reasoning_requested`,
      )
      .safeIntegers(true)
      .all(...params) as unknown as (Sums & { requested: string })[];
    const total: Sums = { calls: 0n, errors: 0n, cost: 0n, input: 0n, output: 0n };
    for (const g of groups) {
      if (rule.kind !== "lower-reasoning" || !exceedsReasoning(g.requested, rule)) continue;
      total.calls += g.calls;
      total.errors += g.errors;
      total.cost += g.cost;
      total.input += g.input;
      total.output += g.output;
    }
    return total;
  }

  #jobs(tenantId: string, agentId: string, from: number, to: number, now: number): JobsCohort {
    const report = new RunOutcomes(this.#db).forTenant(tenantId, { from, to }, now);
    const result = report.agents.find((a) => a.agentId === agentId)?.result;
    if (result === undefined) return { jobs: 0, finished: 0, finishedShare: null, costPerFinishedJob: null };
    const resolved = result.counts.resolved;
    const lcso1 = result.lcso.lcso1;
    return {
      jobs: resolved,
      finished: result.counts.success,
      finishedShare: resolved === 0 ? null : result.counts.success / resolved,
      costPerFinishedJob: lcso1.reported ? lcso1.value.num / lcso1.value.den : null,
    };
  }

  #one(
    tenantId: string,
    policy: MeasurablePolicy,
    liveSince: number,
    now: number,
    withJobs: boolean,
  ): QuickWinMeasurement {
    const baselineFrom = liveSince - MEASURE_BASELINE_DAYS * DAY_MS;
    const before = cohort(this.#before(tenantId, policy, baselineFrom, liveSince));
    const after = cohort(
      this.#sums(
        `AND tenant_id = ? AND id IN (
           SELECT call_id FROM call_adjustments
           WHERE tenant_id = ? AND policy_id = ? AND applied = 1 AND occurred_at >= ?)`,
        [tenantId, tenantId, policy.id, liveSince],
      ),
    );

    const enough = before.calls >= MIN_CALLS_PER_SIDE && after.calls >= MIN_CALLS_PER_SIDE;
    const perCall = enough ? change(before.costPerCall, after.costPerCall) : null;

    let jobs: QuickWinMeasurement["jobs"];
    if (withJobs && policy.scope.kind === "agent") {
      const b = this.#jobs(tenantId, policy.scope.agentId, baselineFrom, liveSince, now);
      const a = this.#jobs(tenantId, policy.scope.agentId, liveSince, now, now);
      jobs = { before: b, after: a, changePerFinishedJob: change(b.costPerFinishedJob, a.costPerFinishedJob) };
    }

    const jobsComparable =
      jobs !== undefined && jobs.before.jobs >= MIN_JOBS_PER_SIDE && jobs.after.jobs >= MIN_JOBS_PER_SIDE;
    const fewerFinished =
      jobsComparable &&
      jobs!.before.finishedShare !== null &&
      jobs!.after.finishedShare !== null &&
      jobs!.after.finishedShare < jobs!.before.finishedShare - FINISHED_SHARE_TOLERANCE;
    // Judge on cost per finished job when there is one: it counts the jobs a
    // lower effort level may have left unfinished.
    const deciding = (jobsComparable ? jobs!.changePerFinishedJob : null) ?? perCall;

    // Checked first and on a small sample: a change that makes calls fail is
    // never a saving, however few calls it has touched.
    const moreErrors =
      after.errors >= MIN_ERRORS_TO_JUDGE &&
      (after.errorRate ?? 0) - (before.errorRate ?? 0) >= ERROR_RATE_TOLERANCE;

    const verdict: QuickWinVerdict = moreErrors
      ? "more-errors"
      : !enough
      ? "not-enough-data"
      : fewerFinished
        ? "fewer-jobs-finished"
        : deciding === null
          ? "not-enough-data"
          : deciding <= -0.02
            ? "cheaper"
            : deciding >= 0.02
              ? "more-expensive"
              : "no-change";

    return {
      policyId: policy.id,
      policyName: policy.name,
      kind: policy.rule.kind as AdjustmentKind,
      scope: policy.scope,
      action: policy.action,
      enabled: policy.enabled,
      liveSince,
      before,
      after,
      changePerCall: perCall,
      ...(jobs !== undefined ? { jobs } : {}),
      verdict,
      caveat: CAVEAT,
    };
  }
}
