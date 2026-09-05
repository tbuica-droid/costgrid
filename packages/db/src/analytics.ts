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
