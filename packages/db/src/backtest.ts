import {
  type Nanodollars,
  type PolicyRule,
  type PolicyScope,
  estimateSaving,
  substitutionAllowed,
} from "@costgrid/core";
import type { Db } from "./database.js";
import type { TimeRange } from "./analytics.js";

/**
 * Replaying a candidate rule against traffic that already happened.
 *
 * This is what makes a proposed rule arguable instead of asserted: before a
 * customer turns anything on, they can see the calls it would have touched and
 * the money it would have moved, computed from their own metered rows rather
 * than from a model of a fleet.
 *
 * The whole file turns on one distinction, and every number it returns is
 * labelled with it.
 */

/**
 * How far a replayed figure can be trusted.
 *
 * `estimated` — the call still happens, priced differently. The only
 * assumption is that token counts carry across models, which they do not
 * exactly (different tokenizers, and small models are often more verbose), so
 * it is an estimate rather than a measurement. This is the sound case.
 *
 * `avoided` — the call would not have happened at all. Calling that a "saving"
 * would be a lie of omission: the customer's software would have done
 * *something* instead, most likely retried, and a blocked feature can cost far
 * more than the tokens it saves. What is reported is spend that would not have
 * occurred, on the assumption nothing downstream reacted — an assumption worth
 * stating out loud every time the number is shown.
 */
export type ReplayBasis = "estimated" | "avoided";

export interface BacktestResult {
  readonly callsInScope: number;
  readonly spendInScope: Nanodollars;
  /** Calls the rule would have refused, downgraded or truncated. */
  readonly callsAffected: number;
  /**
   * Money the rule would have moved, or `undefined` when it cannot be
   * established for enough of the traffic to be worth quoting.
   */
  readonly amount: Nanodollars | undefined;
  readonly basis: ReplayBasis;
  /** Calls in scope whose counterfactual could not be priced. */
  readonly unpriceable: number;
  /** When the rule would first have fired, so "it never fires" is visible. */
  readonly firstFireAt: number | undefined;
  /** The assumption this number rests on, in a sentence. Always present. */
  readonly caveat: string;
}

/**
 * A row exactly as `safeIntegers(true)` hands it back.
 *
 * Every INTEGER column arrives as a bigint, not just the money ones — the flag
 * is per-statement, not per-column. Typing it any other way is a lie the cast
 * at the call site will happily keep, and the failure lands somewhere else
 * entirely: `new Date(bigint)` throws, several frames from the query that
 * caused it.
 */
interface RawCallRow {
  readonly id: string;
  readonly startedAt: bigint;
  readonly agentId: string;
  readonly department: string;
  readonly model: string;
  readonly runId: string;
  readonly runDeclared: bigint;
  readonly costTotal: bigint;
  readonly stopReason: string | null;
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly cacheWrite5mTokens: bigint;
  readonly cacheWrite1hTokens: bigint;
  readonly cacheReadTokens: bigint;
}

/** The same row with everything that is not money converted once, at the edge. */
interface CallRow {
  readonly id: string;
  readonly startedAt: number;
  readonly agentId: string;
  readonly department: string;
  readonly model: string;
  readonly runId: string;
  readonly runDeclared: boolean;
  /** Money stays a bigint. Nanodollars do not survive a round trip through a float. */
  readonly costTotal: bigint;
  readonly stopReason: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheWrite5mTokens: number;
    readonly cacheWrite1hTokens: number;
    readonly cacheReadTokens: number;
  };
}

function normalise(raw: RawCallRow): CallRow {
  return {
    id: raw.id,
    startedAt: Number(raw.startedAt),
    agentId: raw.agentId,
    department: raw.department,
    model: raw.model,
    runId: raw.runId,
    runDeclared: raw.runDeclared === 1n,
    costTotal: raw.costTotal,
    stopReason: raw.stopReason,
    usage: {
      inputTokens: Number(raw.inputTokens),
      outputTokens: Number(raw.outputTokens),
      cacheWrite5mTokens: Number(raw.cacheWrite5mTokens),
      cacheWrite1hTokens: Number(raw.cacheWrite1hTokens),
      cacheReadTokens: Number(raw.cacheReadTokens),
    },
  };
}

const EMPTY = (basis: ReplayBasis, caveat: string): BacktestResult => ({
  callsInScope: 0,
  spendInScope: 0n,
  callsAffected: 0,
  amount: undefined,
  basis,
  unpriceable: 0,
  firstFireAt: undefined,
  caveat,
});

function scopeClause(scope: PolicyScope): { sql: string; params: string[] } {
  switch (scope.kind) {
    case "tenant":
      return { sql: "", params: [] };
    case "department":
      return { sql: " AND department = ?", params: [scope.department] };
    case "agent":
      return { sql: " AND agent_id = ?", params: [scope.agentId] };
  }
}

export class Backtester {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * What this rule would have done to traffic already recorded.
   *
   * Reads only `ok` rows. A call that was blocked or errored did not cost what
   * it would have cost, and replaying a rule against traffic another rule
   * already stopped would double-count the same prevention.
   */
  run(tenantId: string, scope: PolicyScope, rule: PolicyRule, range: TimeRange): BacktestResult {
    const clause = scopeClause(scope);
    const raw = this.#db
      .prepare(
        `SELECT id, started_at AS startedAt, agent_id AS agentId, department, model,
                run_id AS runId, run_declared AS runDeclared, cost_total AS costTotal,
                stop_reason AS stopReason,
                input_tokens AS inputTokens, output_tokens AS outputTokens,
                cache_write_5m_tokens AS cacheWrite5mTokens,
                cache_write_1h_tokens AS cacheWrite1hTokens,
                cache_read_tokens AS cacheReadTokens
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND priced = 1
           AND started_at >= ? AND started_at < ?${clause.sql}
         ORDER BY started_at`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to, ...clause.params) as unknown as RawCallRow[];
    const rows = raw.map(normalise);

    switch (rule.kind) {
      case "route":
        return this.#replayRoute(rows, rule);
      case "model-allowlist":
        return this.#replayBlock(rows, (row) => !rule.models.includes(row.model));
      case "model-denylist":
        return this.#replayBlock(rows, (row) => rule.models.includes(row.model));
      case "budget":
        return this.#replayBudget(rows, rule.limit, rule.window);
      case "run-steps":
        return this.#replayRunSteps(rows, rule.limit);
      case "run-budget":
        return this.#replayRunBudget(rows, rule.limit);
      default:
        /*
         * Deliberately not guessed at. A tool rule fires on the tool list in a
         * request, and requests are not stored — only the names, aggregated.
         * A depth rule needs the delegation shape at the moment of each call.
         * Returning a confident zero for either would be worse than saying so.
         */
        return EMPTY(
          "avoided",
          `${rule.kind} rules cannot be replayed from stored calls; run one in --action monitor instead`,
        );
    }
  }

  // ------------------------------------------------------------------ route

  #replayRoute(rows: readonly CallRow[], rule: Extract<PolicyRule, { kind: "route" }>): BacktestResult {
    const from = rule.from ?? [];
    let callsInScope = 0;
    let spendInScope = 0n;
    let affected = 0;
    let saving = 0n;
    let unpriceable = 0;
    let firstFireAt: number | undefined;

    for (const row of rows) {
      callsInScope += 1;
      spendInScope += row.costTotal;

      if (from.length > 0 && !from.includes(row.model)) continue;
      // The same guard the live evaluator applies: never quote a saving from a
      // substitution the gateway would refuse to make.
      if (!substitutionAllowed(row.model, rule.toModel)) continue;

      const delta = estimateSaving(row.model, rule.toModel, row.usage);
      if (delta === undefined) {
        unpriceable += 1;
        continue;
      }

      affected += 1;
      saving += delta;
      firstFireAt ??= row.startedAt;
    }

    return {
      callsInScope,
      spendInScope,
      callsAffected: affected,
      amount: affected === 0 ? undefined : saving,
      basis: "estimated",
      unpriceable,
      firstFireAt,
      caveat:
        "Prices the same token counts on the cheaper model. Token counts are not " +
        "identical across models, and a smaller model is often more verbose, so " +
        "treat this as an estimate rather than a measurement.",
    };
  }

  // ----------------------------------------------------------------- blocks

  #replayBlock(rows: readonly CallRow[], hits: (row: CallRow) => boolean): BacktestResult {
    let callsInScope = 0;
    let spendInScope = 0n;
    let affected = 0;
    let avoided = 0n;
    let firstFireAt: number | undefined;

    for (const row of rows) {
      callsInScope += 1;
      spendInScope += row.costTotal;
      if (!hits(row)) continue;

      affected += 1;
      avoided += row.costTotal;
      firstFireAt ??= row.startedAt;
    }

    return {
      callsInScope,
      spendInScope,
      callsAffected: affected,
      amount: affected === 0 ? undefined : avoided,
      basis: "avoided",
      unpriceable: 0,
      firstFireAt,
      caveat:
        "This is spend that would not have occurred, not money saved. Each of " +
        "these calls would have been refused, and the software that made it would " +
        "have done something else, most likely retried, possibly failed. Run the " +
        "rule in --action monitor to see the same calls without refusing any.",
    };
  }

  // ---------------------------------------------------------------- budgets

  /**
   * Where a window budget would first have bitten, and what came after it.
   *
   * Walked in time order with the window's own reset, because a budget is a
   * running total and the answer to "would this have fired" depends entirely
   * on when in the window the spend landed.
   */
  #replayBudget(rows: readonly CallRow[], limit: Nanodollars, window: "day" | "month"): BacktestResult {
    let callsInScope = 0;
    let spendInScope = 0n;
    let affected = 0;
    let avoided = 0n;
    let firstFireAt: number | undefined;

    let bucket = "";
    let running = 0n;

    for (const row of rows) {
      callsInScope += 1;
      spendInScope += row.costTotal;

      const key = bucketOf(row.startedAt, window);
      if (key !== bucket) {
        bucket = key;
        running = 0n;
      }

      if (running >= limit) {
        affected += 1;
        avoided += row.costTotal;
        firstFireAt ??= row.startedAt;
        // Refused calls never reach the provider, so they never add to the
        // running total — the same arithmetic the live evaluator does.
        continue;
      }
      running += row.costTotal;
    }

    return {
      callsInScope,
      spendInScope,
      callsAffected: affected,
      amount: affected === 0 ? undefined : avoided,
      basis: "avoided",
      unpriceable: 0,
      firstFireAt,
      caveat:
        `Replays the ${window}ly total in time order and refuses everything past the cap. ` +
        "That is spend prevented, not money saved: those calls would have returned " +
        "an error to whatever made them. A --fallback turns the same cap into a " +
        "downgrade instead, which is usually what a team actually wants.",
    };
  }

  // ------------------------------------------------------------------- runs

  #replayRunSteps(rows: readonly CallRow[], limit: number): BacktestResult {
    return this.#replayPerRun(
      rows,
      (steps) => steps >= limit,
      `Counts every call a run made past step ${limit}. A run that was already ` +
        "looping would have been stopped there; one doing real work would have been " +
        "cut off mid-task. Runs with no x-costgrid-run header are excluded, because " +
        "a rule cannot fire on a run it cannot see.",
    );
  }

  #replayRunBudget(rows: readonly CallRow[], limit: Nanodollars): BacktestResult {
    return this.#replayPerRun(
      rows,
      (_steps, runningCost) => runningCost >= limit,
      "Counts every call a run made after it passed its ceiling. Same caveat as " +
        "any block: this is spend prevented, and a --fallback downgrades instead " +
        "of refusing. Runs with no x-costgrid-run header are excluded.",
    );
  }

  #replayPerRun(
    rows: readonly CallRow[],
    fires: (stepsSoFar: number, costSoFar: Nanodollars) => boolean,
    caveat: string,
  ): BacktestResult {
    let callsInScope = 0;
    let spendInScope = 0n;
    let affected = 0;
    let avoided = 0n;
    let firstFireAt: number | undefined;

    const steps = new Map<string, number>();
    const cost = new Map<string, Nanodollars>();

    for (const row of rows) {
      callsInScope += 1;
      spendInScope += row.costTotal;

      // A synthetic run is one call by construction; a run rule never fires on
      // one live, so it must not appear to fire here either.
      if (!row.runDeclared) continue;

      const soFar = steps.get(row.runId) ?? 0;
      const spentSoFar = cost.get(row.runId) ?? 0n;

      if (fires(soFar, spentSoFar)) {
        affected += 1;
        avoided += row.costTotal;
        firstFireAt ??= row.startedAt;
        continue;
      }

      steps.set(row.runId, soFar + 1);
      cost.set(row.runId, spentSoFar + row.costTotal);
    }

    return {
      callsInScope,
      spendInScope,
      callsAffected: affected,
      amount: affected === 0 ? undefined : avoided,
      basis: "avoided",
      unpriceable: 0,
      firstFireAt,
      caveat,
    };
  }
}

/** UTC bucket key, matching the windows budgets are actually evaluated over. */
function bucketOf(at: number, window: "day" | "month"): string {
  const d = new Date(at);
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return window === "month" ? month : `${month}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
