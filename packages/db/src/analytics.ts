import type { Nanodollars } from "@costgrid/core";
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

export interface TimeRange {
  readonly from: number;
  readonly to: number;
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
