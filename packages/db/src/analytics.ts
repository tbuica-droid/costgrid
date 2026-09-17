import type { Nanodollars, PolicyScope } from "@costgrid/core";
import { findModelPrice } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * Read-side queries backing the dashboard.
 *
 * Separate from `CostGridRepository` because these run on the reporting path,
 * not the metering path: they may be slow, they may be served from a read
 * replica, and none of them writes. Keeping them apart stops a heavy dashboard
 * query from being added to the gateway's critical path by accident.
 */

/**
 * A half-open interval `[from, to)` in epoch milliseconds.
 *
 * Half-open so adjacent windows tile without double-counting a call that lands
 * exactly on a boundary. Build trailing windows with `trailingWindow` rather
 * than by hand — see the note there.
 */
export interface TimeRange {
  readonly from: number;
  readonly to: number;
}

/**
 * A window covering the last `days` days, up to and including this instant.
 *
 * The `+ 1` is load-bearing. `TimeRange` is half-open, and a call recorded in
 * the same millisecond as the query has `started_at === Date.now()`, which
 * `started_at < to` excludes. Without it the most recent calls flicker in and
 * out of the dashboard depending on how the millisecond boundary falls —
 * rare enough to look like a phantom, frequent enough to erode trust in the
 * numbers.
 */
export function trailingWindow(days: number, now = Date.now()): TimeRange {
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new RangeError(`days must be an integer 1..3650, got ${days}`);
  }
  return { from: now - days * 24 * 60 * 60 * 1000, to: now + 1 };
}

export interface SpendBucket {
  /** UTC day, as "YYYY-MM-DD". */
  readonly day: string;
  readonly cost: Nanodollars;
  readonly calls: number;
}

export interface GroupedSpend {
  readonly key: string;
  readonly cost: Nanodollars;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AgentDetail {
  readonly agentId: string;
  readonly department: string;
  readonly calls: number;
  readonly okCalls: number;
  readonly erroredCalls: number;
  readonly blockedCalls: number;
  readonly cost: Nanodollars;
  readonly costPerCall: Nanodollars;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheHitRatio: number;
  readonly errorRate: number;
  readonly lastSeenAt: number;
}

export interface TierBreakdown {
  readonly tier: string;
  readonly tokens: number;
  readonly cost: Nanodollars;
  readonly calls: number;
}

/**
 * What auto-routing achieved, and what a dry run says it would achieve.
 *
 * Kept as two separate figures. A customer running rules in dry-run mode has
 * saved nothing yet, and reporting a projection as a realised saving is the
 * fastest way to lose their trust in every other number on the page.
 */
export interface RoutingSavings {
  /** Calls actually rewritten to a different model. */
  readonly routedCalls: number;
  /** Calls a dry-run rule matched but did not change. */
  readonly dryRunCalls: number;
  /** Estimated saving on calls that were genuinely rerouted. Signed. */
  readonly realisedSaving: Nanodollars;
  /** Estimated saving a dry run would have produced, had it been enabled. */
  readonly potentialSaving: Nanodollars;
}

export interface FleetSummary {
  readonly totalCost: Nanodollars;
  readonly calls: number;
  readonly blockedCalls: number;
  readonly erroredCalls: number;
  /** Calls whose model was absent from the price catalog; their cost reads as 0. */
  readonly unpricedCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /**
   * Fraction of billable tokens served from cache, 0..1. The cheapest saving
   * available, and usually the first one a new client has left on the table.
   */
  readonly cacheHitRatio: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly agentId: string;
  readonly department: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly calls: number;
  readonly blockedCalls: number;
  readonly cost: Nanodollars;
  readonly depth: number;
  readonly models: number;
}

export interface RunStep {
  /** Position in the run, one-based. Derived from order, not stored. */
  readonly step: number;
  readonly id: string;
  readonly agentId: string;
  readonly model: string;
  readonly requestedModel: string | undefined;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly cost: Nanodollars;
  readonly outcome: string;
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
  readonly depth: number;
  readonly parentRunId: string | undefined;
}

export class Analytics {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  summary(tenantId: string, range: TimeRange): FleetSummary {
    const row = this.#db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END), 0) AS totalCost,
           COUNT(*)                                                              AS calls,
           COALESCE(SUM(CASE WHEN outcome = 'blocked' THEN 1 ELSE 0 END), 0)     AS blockedCalls,
           COALESCE(SUM(CASE WHEN outcome = 'error'   THEN 1 ELSE 0 END), 0)     AS erroredCalls,
           COALESCE(SUM(CASE WHEN priced = 0          THEN 1 ELSE 0 END), 0)     AS unpricedCalls,
           COALESCE(SUM(input_tokens), 0)                                        AS inputTokens,
           COALESCE(SUM(output_tokens), 0)                                       AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0)                                   AS cacheReadTokens
         FROM calls
         WHERE tenant_id = ? AND started_at >= ? AND started_at < ?`,
      )
      .safeIntegers(true)
      .get(tenantId, range.from, range.to) as Record<string, bigint>;

    const inputTokens = Number(row["inputTokens"]);
    const cacheReadTokens = Number(row["cacheReadTokens"]);
    const readable = inputTokens + cacheReadTokens;

    return {
      totalCost: row["totalCost"]!,
      calls: Number(row["calls"]),
      blockedCalls: Number(row["blockedCalls"]),
      erroredCalls: Number(row["erroredCalls"]),
      unpricedCalls: Number(row["unpricedCalls"]),
      inputTokens,
      outputTokens: Number(row["outputTokens"]),
      cacheReadTokens,
      cacheHitRatio: readable === 0 ? 0 : cacheReadTokens / readable,
    };
  }

  dailySpend(tenantId: string, range: TimeRange): SpendBucket[] {
    const rows = this.#db
      .prepare(
        `SELECT
           strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day,
           COALESCE(SUM(cost_total), 0)                          AS cost,
           COUNT(*)                                              AS calls
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
         GROUP BY day
         ORDER BY day`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to) as { day: string; cost: bigint; calls: bigint }[];

    return rows.map((r) => ({ day: r.day, cost: r.cost, calls: Number(r.calls) }));
  }

  #groupBy(column: "agent_id" | "model" | "department", tenantId: string, range: TimeRange) {
    const rows = this.#db
      .prepare(
        `SELECT
           ${column}                        AS key,
           COALESCE(SUM(cost_total), 0)     AS cost,
           COUNT(*)                         AS calls,
           COALESCE(SUM(input_tokens), 0)   AS inputTokens,
           COALESCE(SUM(output_tokens), 0)  AS outputTokens
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
         GROUP BY ${column}
         ORDER BY cost DESC`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to) as Record<string, bigint | string>[];

    return rows.map((r) => ({
      key: r["key"] as string,
      cost: r["cost"] as bigint,
      calls: Number(r["calls"]),
      inputTokens: Number(r["inputTokens"]),
      outputTokens: Number(r["outputTokens"]),
    }));
  }

  spendByAgent(tenantId: string, range: TimeRange): GroupedSpend[] {
    return this.#groupBy("agent_id", tenantId, range);
  }

  spendByModel(tenantId: string, range: TimeRange): GroupedSpend[] {
    return this.#groupBy("model", tenantId, range);
  }

  spendByDepartment(tenantId: string, range: TimeRange): GroupedSpend[] {
    return this.#groupBy("department", tenantId, range);
  }

  /**
   * The observed substitution share: the fraction of billable tokens served by
   * non-frontier tiers.
   *
   * This is the measured counterpart to the routing model's `s`. Every prior
   * version of CostGrid assumed this number; here it is computed from traffic.
   * Tokens on models missing from the price catalog have no known tier and are
   * excluded from both sides of the ratio rather than guessed at.
   */
  substitutionShare(tenantId: string, range: TimeRange): number {
    const rows = this.#db
      .prepare(
        `SELECT model,
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens), 0) AS tokens
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
         GROUP BY model`,
      )
      .all(tenantId, range.from, range.to) as { model: string; tokens: number }[];

    let classified = 0;
    let substituted = 0;
    for (const row of rows) {
      const price = findModelPrice(row.model);
      if (!price) continue;
      classified += row.tokens;
      if (price.tier !== "frontier") substituted += row.tokens;
    }
    return classified === 0 ? 0 : substituted / classified;
  }

  /**
   * Per-agent detail for the cost explorer.
   *
   * The demo dashboard invented a "success rate" and a "useful token ratio"
   * per agent. Neither is observable from a proxy: we see tokens and status
   * codes, not whether the answer was any good. What is real is the error
   * rate, the cache hit ratio and the cost per call — so those are reported,
   * and the invented metrics are not.
   */
  agentDetail(tenantId: string, range: TimeRange): AgentDetail[] {
    const rows = this.#db
      .prepare(
        `SELECT
           agent_id                                                            AS agentId,
           department,
           COUNT(*)                                                            AS calls,
           COALESCE(SUM(CASE WHEN outcome = 'ok'      THEN 1 ELSE 0 END), 0)   AS okCalls,
           COALESCE(SUM(CASE WHEN outcome = 'error'   THEN 1 ELSE 0 END), 0)   AS erroredCalls,
           COALESCE(SUM(CASE WHEN outcome = 'blocked' THEN 1 ELSE 0 END), 0)   AS blockedCalls,
           COALESCE(SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END), 0) AS cost,
           COALESCE(SUM(input_tokens), 0)                                      AS inputTokens,
           COALESCE(SUM(output_tokens), 0)                                     AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0)                                 AS cacheReadTokens,
           COALESCE(MAX(started_at), 0)                                        AS lastSeenAt
         FROM calls
         WHERE tenant_id = ? AND started_at >= ? AND started_at < ?
         GROUP BY agent_id, department
         ORDER BY cost DESC`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to) as Record<string, bigint | string>[];

    return rows.map((r) => {
      const cost = r["cost"] as bigint;
      const calls = Number(r["calls"]);
      const okCalls = Number(r["okCalls"]);
      const inputTokens = Number(r["inputTokens"]);
      const cacheReadTokens = Number(r["cacheReadTokens"]);
      const readable = inputTokens + cacheReadTokens;

      return {
        agentId: r["agentId"] as string,
        department: r["department"] as string,
        calls,
        okCalls,
        erroredCalls: Number(r["erroredCalls"]),
        blockedCalls: Number(r["blockedCalls"]),
        cost,
        // Cost per *successful* call — a blocked call cost nothing and would
        // otherwise flatter the average.
        costPerCall: okCalls === 0 ? 0n : cost / BigInt(okCalls),
        inputTokens,
        outputTokens: Number(r["outputTokens"]),
        cacheReadTokens,
        cacheHitRatio: readable === 0 ? 0 : cacheReadTokens / readable,
        errorRate: calls === 0 ? 0 : Number(r["erroredCalls"]) / calls,
        lastSeenAt: Number(r["lastSeenAt"]),
      };
    });
  }

  /** Which tier each model sits in, for the routing view. */
  tierBreakdown(tenantId: string, range: TimeRange): TierBreakdown[] {
    const rows = this.#db
      .prepare(
        `SELECT model,
                COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens), 0) AS tokens,
                COALESCE(SUM(cost_total), 0) AS cost,
                COUNT(*) AS calls
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
         GROUP BY model`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to) as Record<string, bigint | string>[];

    const byTier = new Map<string, { tokens: number; cost: bigint; calls: number }>();
    for (const row of rows) {
      const price = findModelPrice(row["model"] as string);
      // An uncatalogued model has no known tier; "unknown" keeps it visible
      // rather than silently folding it into a tier it may not belong to.
      const tier = price?.tier ?? "unknown";
      const entry = byTier.get(tier) ?? { tokens: 0, cost: 0n, calls: 0 };
      entry.tokens += Number(row["tokens"]);
      entry.cost += row["cost"] as bigint;
      entry.calls += Number(row["calls"]);
      byTier.set(tier, entry);
    }

    return [...byTier.entries()].map(([tier, v]) => ({ tier, ...v }));
  }

  /**
   * Realised and potential savings from route rules.
   *
   * Both figures are estimates: they price the observed token counts at the
   * model the caller originally requested. Token counts are not invariant
   * across models, so this is the closest honest answer short of running every
   * prompt twice.
   */
  routingSavings(tenantId: string, range: TimeRange): RoutingSavings {
    const row = this.#db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN routed = 1 THEN 1 ELSE 0 END), 0)                        AS routedCalls,
           COALESCE(SUM(CASE WHEN route_dry_run = 1 THEN 1 ELSE 0 END), 0)                 AS dryRunCalls,
           COALESCE(SUM(CASE WHEN routed = 1 THEN saving_estimate ELSE 0 END), 0)          AS realised,
           COALESCE(SUM(CASE WHEN route_dry_run = 1 THEN saving_estimate ELSE 0 END), 0)   AS potential
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?`,
      )
      .safeIntegers(true)
      .get(tenantId, range.from, range.to) as Record<string, bigint>;

    return {
      routedCalls: Number(row["routedCalls"]),
      dryRunCalls: Number(row["dryRunCalls"]),
      realisedSaving: row["realised"]!,
      potentialSaving: row["potential"]!,
    };
  }

  /** Per-substitution detail, so a saving can be audited rather than trusted. */
  routingBreakdown(tenantId: string, range: TimeRange) {
    const rows = this.#db
      .prepare(
        `SELECT requested_model AS requestedModel, model AS servedModel,
                route_dry_run AS dryRun,
                COUNT(*) AS calls,
                COALESCE(SUM(saving_estimate), 0) AS saving,
                COALESCE(SUM(cost_total), 0)      AS cost
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND requested_model IS NOT NULL
           AND started_at >= ? AND started_at < ?
         GROUP BY requested_model, model, route_dry_run
         ORDER BY saving DESC`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to) as Record<string, bigint | string>[];

    return rows.map((r) => ({
      requestedModel: r["requestedModel"] as string,
      servedModel: r["servedModel"] as string,
      dryRun: Number(r["dryRun"]) === 1,
      calls: Number(r["calls"]),
      saving: r["saving"] as bigint,
      cost: r["cost"] as bigint,
    }));
  }

  /**
   * Spend inside one window, narrowed to a policy's scope and broken out by
   * UTC day.
   *
   * Written for the monthly statement's budget table, where a daily cap has to
   * be judged against the worst day of the month rather than the month total —
   * a $50/day cap and $1,200 of monthly spend say nothing about each other.
   */
  spendInRange(
    tenantId: string,
    range: TimeRange,
    scope: PolicyScope,
  ): { total: Nanodollars; days: { day: string; cost: Nanodollars }[] } {
    let filter = "";
    const scopeParams: unknown[] = [];
    if (scope.kind === "agent") {
      filter = " AND agent_id = ?";
      scopeParams.push(scope.agentId);
    } else if (scope.kind === "department") {
      filter = " AND department = ?";
      scopeParams.push(scope.department);
    }

    const rows = this.#db
      .prepare(
        `SELECT
           strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day,
           COALESCE(SUM(cost_total), 0)                          AS cost
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok'
           AND started_at >= ? AND started_at < ?${filter}
         GROUP BY day
         ORDER BY day`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to, ...scopeParams) as { day: string; cost: bigint }[];

    const days = rows.map((r) => ({ day: r.day, cost: r.cost }));
    return { total: days.reduce((sum, d) => sum + d.cost, 0n), days };
  }

  /**
   * Runs in a window, most expensive first.
   *
   * Only runs the caller actually declared appear. Every other call is a run
   * of one, and listing thousands of those would bury the handful of real
   * multi-step runs this view exists to show.
   */
  runsSummary(tenantId: string, range: TimeRange, limit = 50): RunSummary[] {
    const rows = this.#db
      .prepare(
        `SELECT run_id                                   AS runId,
                MIN(started_at)                          AS startedAt,
                MAX(started_at + duration_ms)            AS endedAt,
                COUNT(*)                                 AS calls,
                COALESCE(SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END), 0) AS cost,
                COALESCE(SUM(CASE WHEN outcome = 'blocked' THEN 1 ELSE 0 END), 0)     AS blockedCalls,
                MAX(run_depth)                           AS depth,
                MIN(agent_id)                            AS agentId,
                MIN(department)                          AS department,
                COUNT(DISTINCT model)                    AS models
         FROM calls
         WHERE tenant_id = ? AND run_declared = 1
           AND started_at >= ? AND started_at < ?
         GROUP BY run_id
         ORDER BY cost DESC
         LIMIT ?`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to, limit) as Record<string, bigint | string>[];

    return rows.map((r) => ({
      runId: r["runId"] as string,
      agentId: r["agentId"] as string,
      department: r["department"] as string,
      startedAt: Number(r["startedAt"]),
      endedAt: Number(r["endedAt"]),
      calls: Number(r["calls"]),
      blockedCalls: Number(r["blockedCalls"]),
      cost: r["cost"] as bigint,
      depth: Number(r["depth"]),
      models: Number(r["models"]),
    }));
  }

  /** Every call in one run, in the order it happened. */
  runDetail(tenantId: string, runId: string): RunStep[] {
    const rows = this.#db
      .prepare(
        `SELECT id, model, requested_model AS requestedModel, agent_id AS agentId,
                started_at AS startedAt, duration_ms AS durationMs,
                cost_total AS cost, outcome, stop_reason AS stopReason,
                error_message AS errorMessage, run_depth AS depth,
                parent_run_id AS parentRunId
         FROM calls
         WHERE tenant_id = ? AND run_id = ?
         ORDER BY started_at, id`,
      )
      .safeIntegers(true)
      .all(tenantId, runId) as Record<string, bigint | string | null>[];

    return rows.map((r, index) => ({
      step: index + 1,
      id: r["id"] as string,
      agentId: r["agentId"] as string,
      model: r["model"] as string,
      requestedModel: (r["requestedModel"] as string | null) ?? undefined,
      startedAt: Number(r["startedAt"]),
      durationMs: Number(r["durationMs"]),
      cost: r["cost"] as bigint,
      outcome: r["outcome"] as string,
      stopReason: (r["stopReason"] as string | null) ?? undefined,
      errorMessage: (r["errorMessage"] as string | null) ?? undefined,
      depth: Number(r["depth"]),
      parentRunId: (r["parentRunId"] as string | null) ?? undefined,
    }));
  }

  /**
   * How much traffic carries a run id at all.
   *
   * Run policies cannot fire on undeclared runs, so a fleet at 0% has the
   * rules configured and nothing enforcing them. That is worth showing rather
   * than leaving someone to infer it from a feed that never fills.
   */
  runCoverage(tenantId: string, range: TimeRange): { declared: number; total: number } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN run_declared = 1 THEN 1 ELSE 0 END), 0) AS declared
         FROM calls
         WHERE tenant_id = ? AND started_at >= ? AND started_at < ?`,
      )
      .get(tenantId, range.from, range.to) as { total: number; declared: number };
    return { declared: row.declared, total: row.total };
  }

  recentViolations(tenantId: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError(`limit must be an integer 1..1000, got ${limit}`);
    }
    return this.#db
      .prepare(
        `SELECT v.id, v.call_id AS callId, v.policy_name AS policyName, v.action, v.reason,
                v.occurred_at AS occurredAt, c.agent_id AS agentId, c.model
         FROM violations v
         LEFT JOIN calls c ON c.id = v.call_id
         WHERE v.tenant_id = ?
         ORDER BY v.occurred_at DESC
         LIMIT ?`,
      )
      .all(tenantId, limit) as {
      id: string;
      callId: string;
      policyName: string;
      action: string;
      reason: string;
      occurredAt: number;
      agentId: string | null;
      model: string | null;
    }[];
  }
}
