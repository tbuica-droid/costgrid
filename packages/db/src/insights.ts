import type { Nanodollars } from "@costgrid/core";
import type { Db } from "./database.js";
import type { TimeRange } from "./analytics.js";

/**
 * Two readings of a fleet's own traffic that the research says matter and
 * that a spend total hides.
 *
 * **How much a run costs varies, a lot.** Bai et al. ran the same agentic
 * tasks repeatedly and found runs differing by up to 30x in tokens, with
 * frontier models unable to predict their own cost beforehand (correlation
 * at most 0.39; arXiv:2604.22750). Chen et al. found a 9.7x spread in thinking
 * tokens on repeats of the same query (arXiv:2603.23971). So an average cost
 * per run is the wrong summary: the median says what a normal run costs and
 * the 95th percentile says what a bad one does. Both are shown, per agent.
 *
 * **Where reasoning money goes.** Reasoning tokens explain most of the gap
 * between list price and real cost (arXiv:2603.23971), and on simple tasks
 * extra reasoning tends to cost more without helping (arXiv:2506.06941).
 *
 * Everything here is read from metered rows. Nothing is estimated except
 * where the field name says so.
 */

export interface RunSpread {
  readonly agentId: string;
  /** Declared runs in the window. Runs of one call invented by CostGrid are excluded. */
  readonly runs: number;
  readonly median: Nanodollars;
  readonly p95: Nanodollars;
  readonly max: Nanodollars;
  readonly mean: Nanodollars;
  readonly medianSteps: number;
  readonly p95Steps: number;
}

export interface ReasoningByModel {
  readonly model: string;
  readonly provider: string;
  readonly calls: number;
  readonly cost: Nanodollars;
  /** Calls whose provider reported a reasoning-token figure. */
  readonly reportedCalls: number;
  readonly reasoningTokens: number;
  readonly outputTokens: number;
  /**
   * What the reported reasoning tokens cost.
   *
   * Exact rather than estimated: reasoning tokens bill at the output rate, so
   * each call's share of its output cost is its share of output tokens. Covers
   * only calls that reported a figure.
   */
  readonly reasoningCost: Nanodollars;
}

export interface ReasoningByRequest {
  /** `effort:high`, `budget:8000`, `thinking`, or `not specified`. */
  readonly requested: string;
  readonly calls: number;
  readonly cost: Nanodollars;
}

export interface OverthinkingSignal {
  readonly agentId: string;
  readonly calls: number;
  readonly reasoningCost: Nanodollars;
}

export interface ReasoningReport {
  readonly byModel: readonly ReasoningByModel[];
  readonly byRequest: readonly ReasoningByRequest[];
  /**
   * Calls that thought a lot to say a little: under 200 visible output tokens
   * after at least four times that much reasoning.
   *
   * A signal, not a verdict. Some short answers need hard thought. But the
   * pattern is the one "The Illusion of Thinking" documents on simple
   * problems, and it is the first place to try a lower effort level.
   */
  readonly overthinking: readonly OverthinkingSignal[];
}

/** Nearest-rank percentile of an ascending list. */
function percentile<T>(sorted: readonly T[], p: number): T {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

const byBigint = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

export class Insights {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Cost per run, per agent: median, 95th percentile and worst.
   *
   * A run is attributed to the agent that made its first call. Only `ok`
   * calls carry cost; a blocked call cost nothing and an errored one is not
   * billed as spend anywhere else in CostGrid either.
   */
  runSpread(tenantId: string, range: TimeRange, agentId?: string): RunSpread[] {
    const rows = this.#db
      .prepare(
        `SELECT run_id AS runId,
                MIN(agent_id) AS agentId,
                SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END) AS cost,
                SUM(CASE WHEN outcome != 'blocked' THEN 1 ELSE 0 END) AS steps
         FROM calls
         WHERE tenant_id = ? AND run_declared = 1
           AND started_at >= ? AND started_at < ?
           ${agentId === undefined ? "" : "AND agent_id = ?"}
         GROUP BY run_id`,
      )
      .safeIntegers(true)
      .all(
        ...[tenantId, range.from, range.to, ...(agentId === undefined ? [] : [agentId])],
      ) as { runId: string; agentId: string; cost: bigint; steps: bigint }[];

    const perAgent = new Map<string, { costs: bigint[]; steps: number[] }>();
    for (const row of rows) {
      const entry = perAgent.get(row.agentId) ?? { costs: [], steps: [] };
      entry.costs.push(row.cost);
      entry.steps.push(Number(row.steps));
      perAgent.set(row.agentId, entry);
    }

    const out: RunSpread[] = [];
    for (const [agent, { costs, steps }] of perAgent) {
      costs.sort(byBigint);
      steps.sort((a, b) => a - b);
      const total = costs.reduce((sum, c) => sum + c, 0n);
      out.push({
        agentId: agent,
        runs: costs.length,
        median: percentile(costs, 0.5),
        p95: percentile(costs, 0.95),
        max: costs[costs.length - 1]!,
        mean: total / BigInt(costs.length),
        medianSteps: percentile(steps, 0.5),
        p95Steps: percentile(steps, 0.95),
      });
    }
    return out.sort((a, b) => byBigint(b.p95, a.p95));
  }

  reasoning(tenantId: string, range: TimeRange): ReasoningReport {
    const byModel = this.#db
      .prepare(
        `SELECT model, provider,
                COUNT(*) AS calls,
                COALESCE(SUM(cost_total), 0) AS cost,
                COALESCE(SUM(CASE WHEN reasoning_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS reportedCalls,
                COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoningTokens,
                COALESCE(SUM(CASE WHEN reasoning_tokens IS NOT NULL THEN output_tokens ELSE 0 END), 0) AS outputTokens,
                COALESCE(SUM(CASE WHEN reasoning_tokens IS NOT NULL AND output_tokens > 0
                                  THEN cost_output * reasoning_tokens / output_tokens ELSE 0 END), 0) AS reasoningCost
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
         GROUP BY model, provider
         ORDER BY cost DESC`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to) as Record<string, bigint | string>[];

    const byRequest = this.#db
      .prepare(
        `SELECT COALESCE(reasoning_requested, 'not specified') AS requested,
                COUNT(*) AS calls,
                COALESCE(SUM(cost_total), 0) AS cost
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
         GROUP BY requested
         ORDER BY cost DESC`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to) as Record<string, bigint | string>[];

    const overthinking = this.#db
      .prepare(
        `SELECT agent_id AS agentId,
                COUNT(*) AS calls,
                COALESCE(SUM(cost_output * reasoning_tokens / output_tokens), 0) AS reasoningCost
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
           AND reasoning_tokens IS NOT NULL AND output_tokens > 0
           AND output_tokens - reasoning_tokens < 200
           AND reasoning_tokens >= 4 * (output_tokens - reasoning_tokens)
         GROUP BY agent_id
         ORDER BY reasoningCost DESC`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to) as Record<string, bigint | string>[];

    return {
      byModel: byModel.map((r) => ({
        model: r["model"] as string,
        provider: r["provider"] as string,
        calls: Number(r["calls"]),
        cost: r["cost"] as bigint,
        reportedCalls: Number(r["reportedCalls"]),
        reasoningTokens: Number(r["reasoningTokens"]),
        outputTokens: Number(r["outputTokens"]),
        reasoningCost: r["reasoningCost"] as bigint,
      })),
      byRequest: byRequest.map((r) => ({
        requested: r["requested"] as string,
        calls: Number(r["calls"]),
        cost: r["cost"] as bigint,
      })),
      overthinking: overthinking.map((r) => ({
        agentId: r["agentId"] as string,
        calls: Number(r["calls"]),
        reasoningCost: r["reasoningCost"] as bigint,
      })),
    };
  }
}
