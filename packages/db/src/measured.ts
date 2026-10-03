import type { Nanodollars, Policy, PolicyScope } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * Did switching to the cheaper model actually save money? Measured, not assumed.
 *
 * Every saving CostGrid showed before this was an estimate: the tokens a call
 * used, priced at the model the caller asked for. That assumes a different
 * model would have used the same number of tokens, and Chen et al. show the
 * assumption fails often enough to matter. In 32% of the model pairs they
 * tested, the model with the lower list price cost more in total, by up to
 * 28x, because it thought longer or took more turns ("The Price Reversal
 * Phenomenon", arXiv:2603.23971).
 *
 * So for every rule that has actually moved traffic, this compares the same
 * scope's calls on the original model in the fortnight before the rule went
 * live against the calls the rule moved afterwards: cost per call, tokens per
 * call, and, where runs are declared, cost per run. Cost per run is the figure
 * that catches a cheaper model which needs more steps to finish the job.
 *
 * What it is not: a controlled experiment. If the work itself changed when the
 * rule went live, part of the difference is that, and every result says so.
 * Below a minimum sample it says "not enough data" rather than a number.
 */

export const MEASURE_BASELINE_DAYS = 14;
export const MIN_CALLS_PER_SIDE = 30;
export const MIN_RUNS_PER_SIDE = 10;

export interface Cohort {
  readonly calls: number;
  readonly costPerCall: Nanodollars | null;
  readonly outputTokensPerCall: number | null;
  /** Among calls whose provider reported reasoning tokens; null when none did. */
  readonly reasoningTokensPerCall: number | null;
  readonly runs: number;
  readonly costPerRun: Nanodollars | null;
}

export type Verdict = "cheaper" | "more-expensive" | "no-change" | "not-enough-data";

export interface MeasuredSwitch {
  readonly policyId: string;
  readonly policyName: string;
  readonly fromModel: string;
  readonly toModel: string;
  readonly liveSince: number;
  readonly before: Cohort;
  readonly after: Cohort;
  /** The old method: same tokens, priced at the original model. Per call. */
  readonly estimatedSavingPerCall: Nanodollars | null;
  /** Before minus after, per call. Positive is a saving. */
  readonly measuredSavingPerCall: Nanodollars | null;
  /** After against before, per call, as a fraction: -0.4 is 40% cheaper. */
  readonly changePerCall: number | null;
  /** Same, per run, where enough runs were declared on both sides. */
  readonly changePerRun: number | null;
  readonly verdict: Verdict;
  readonly caveat: string;
}

const CAVEAT =
  "Before and after on your own traffic, not a controlled experiment. If the work changed " +
  "when the rule went live, part of this difference is that.";

function scopeFilter(scope: PolicyScope): { sql: string; params: string[] } {
  if (scope.kind === "agent") return { sql: " AND agent_id = ?", params: [scope.agentId] };
  if (scope.kind === "department") return { sql: " AND department = ?", params: [scope.department] };
  return { sql: "", params: [] };
}

function cohort(
  calls: { calls: bigint; cost: bigint; output: bigint; reasoning: bigint; reported: bigint },
  runs: { runs: bigint; cost: bigint },
): Cohort {
  const n = Number(calls.calls);
  const r = Number(runs.runs);
  const reported = Number(calls.reported);
  return {
    calls: n,
    costPerCall: n === 0 ? null : calls.cost / BigInt(n),
    outputTokensPerCall: n === 0 ? null : Math.round(Number(calls.output) / n),
    reasoningTokensPerCall: reported === 0 ? null : Math.round(Number(calls.reasoning) / reported),
    runs: r,
    costPerRun: r === 0 ? null : runs.cost / BigInt(r),
  };
}

function change(before: bigint | null, after: bigint | null): number | null {
  if (before === null || after === null || before === 0n) return null;
  return Number(after - before) / Number(before);
}

export class MeasuredSavings {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * One entry per (rule, from-model, to-model) the rule has actually applied.
   *
   * `policies` carries `liveSince` where known; a rule without one falls back
   * to its creation time, which is right for every rule created enforcing.
   */
  forPolicies(
    tenantId: string,
    policies: readonly (Policy & { liveSince: number | null; createdAt: number })[],
  ): MeasuredSwitch[] {
    const out: MeasuredSwitch[] = [];
    for (const policy of policies) {
      const moves =
        policy.rule.kind === "route" ||
        ((policy.rule.kind === "budget" || policy.rule.kind === "run-budget") &&
          policy.rule.fallbackModel !== undefined);
      if (!moves || policy.action === "monitor") continue;
      out.push(...this.#forPolicy(tenantId, policy, policy.liveSince ?? policy.createdAt));
    }
    return out;
  }

  #forPolicy(tenantId: string, policy: Policy, liveSince: number): MeasuredSwitch[] {
    const moved = `id IN (SELECT call_id FROM violations WHERE tenant_id = ? AND policy_id = ?)`;

    const pairs = this.#db
      .prepare(
        `SELECT requested_model AS fromModel, model AS toModel
         FROM calls
         WHERE tenant_id = ? AND routed = 1 AND outcome = 'ok' AND ${moved}
         GROUP BY requested_model, model`,
      )
      .all(tenantId, tenantId, policy.id) as { fromModel: string; toModel: string }[];

    const scope = scopeFilter(policy.scope);
    const baselineFrom = liveSince - MEASURE_BASELINE_DAYS * 86_400_000;

    const callStats = (where: string, params: unknown[]) =>
      this.#db
        .prepare(
          `SELECT COUNT(*) AS calls,
                  COALESCE(SUM(cost_total), 0) AS cost,
                  COALESCE(SUM(output_tokens), 0) AS output,
                  COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoning,
                  COALESCE(SUM(CASE WHEN reasoning_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS reported,
                  COALESCE(SUM(saving_estimate), 0) AS estimated
           FROM calls WHERE tenant_id = ? AND outcome = 'ok' ${where}`,
        )
        .safeIntegers(true)
        .get(tenantId, ...params) as {
        calls: bigint;
        cost: bigint;
        output: bigint;
        reasoning: bigint;
        reported: bigint;
        estimated: bigint;
      };

    // Whole-run cost, for runs that touched the cohort. A cheaper model that
    // needs more steps shows up here and nowhere else.
    const runStats = (cohortWhere: string, params: unknown[]) =>
      this.#db
        .prepare(
          `SELECT COUNT(*) AS runs, COALESCE(SUM(cost), 0) AS cost FROM (
             SELECT run_id, SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END) AS cost
             FROM calls
             WHERE tenant_id = ? AND run_declared = 1
               AND run_id IN (SELECT run_id FROM calls WHERE tenant_id = ? AND run_declared = 1 ${cohortWhere})
             GROUP BY run_id
           )`,
        )
        .safeIntegers(true)
        .get(tenantId, tenantId, ...params) as { runs: bigint; cost: bigint };

    return pairs.map(({ fromModel, toModel }) => {
      const beforeWhere =
        `AND model = ? AND routed = 0 AND started_at >= ? AND started_at < ?${scope.sql}`;
      const beforeParams = [fromModel, baselineFrom, liveSince, ...scope.params];
      const afterWhere = `AND routed = 1 AND requested_model = ? AND model = ? AND ${moved}`;
      const afterParams = [fromModel, toModel, tenantId, policy.id];

      const b = callStats(beforeWhere, beforeParams);
      const a = callStats(afterWhere, afterParams);
      // Runs that touched each cohort, costed whole. A run straddling the
      // moment the rule went live is rare and lands on both sides.
      const beforeRuns = runStats(`${beforeWhere} AND outcome = 'ok'`, beforeParams);
      const afterRuns = runStats(`${afterWhere} AND outcome = 'ok'`, afterParams);

      const before = cohort(b, beforeRuns);
      const after = cohort(a, afterRuns);
      const enough = before.calls >= MIN_CALLS_PER_SIDE && after.calls >= MIN_CALLS_PER_SIDE;
      const perCall = change(before.costPerCall, after.costPerCall);
      const enoughRuns = before.runs >= MIN_RUNS_PER_SIDE && after.runs >= MIN_RUNS_PER_SIDE;
      const perRun = enoughRuns ? change(before.costPerRun, after.costPerRun) : null;

      // Judge on the run figure when there is one: it is the one that includes
      // extra steps a cheaper model may need.
      const deciding = perRun ?? perCall;
      const verdict: Verdict =
        !enough || deciding === null
          ? "not-enough-data"
          : deciding <= -0.02
            ? "cheaper"
            : deciding >= 0.02
              ? "more-expensive"
              : "no-change";

      return {
        policyId: policy.id,
        policyName: policy.name,
        fromModel,
        toModel,
        liveSince,
        before,
        after,
        estimatedSavingPerCall: after.calls === 0 ? null : a.estimated / BigInt(after.calls),
        measuredSavingPerCall:
          before.costPerCall === null || after.costPerCall === null
            ? null
            : before.costPerCall - after.costPerCall,
        changePerCall: enough ? perCall : null,
        changePerRun: perRun,
        verdict,
        caveat: CAVEAT,
      };
    });
  }
}
