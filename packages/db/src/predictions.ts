import {
  type Candidate,
  costOfOpen,
  type Evidence,
  findModelPrice,
  listModelPrices,
  type Nanodollars,
  NO_EVIDENCE,
  priceUsage,
  rankModels,
  type Ranked,
  type RoutingMode,
  type TaskKind,
  type TokenUsage,
  ZERO_USAGE,
} from "@costgrid/core";
import type { Db } from "./database.js";
import { EndpointsRepository } from "./endpoints.js";
import { DEFAULT_QUALITY_BAR_MILLI, QualityRepository } from "./quality.js";

/**
 * The evidence behind each model's prediction for one agent (v3, phase 4).
 *
 * From the agent's own traffic over the window:
 *   - quality: answer checks that passed or found the format wrong, and
 *     reported scores against the agent's bar, with edited or rejected
 *     signals counting as below it;
 *   - finishing: calls that went through and were not cut off or refused,
 *     and reported outcomes;
 *   - cost: what its calls on that model actually cost.
 *
 * Candidates are the models the agent may be sent to: its own provider's, the
 * providers it opted in to, and priced models on endpoints it opted in to. A
 * model it has not used is costed at its price with the agent's usual tokens,
 * and labelled as an estimate.
 */

const DAY = 86_400_000;

export interface AgentPredictions {
  readonly agentId: string;
  readonly kind: TaskKind | undefined;
  readonly current: string | undefined;
  readonly callsPerJob: number;
  /** Calls in the window with a label, and in all. */
  readonly labelled: number;
  readonly calls: number;
  readonly ranked: readonly Ranked[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class Predictions {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  forAgent(
    tenantId: string,
    agentId: string,
    opts: { kind?: TaskKind | undefined; now?: number; days?: number; mode?: RoutingMode } = {},
  ): AgentPredictions {
    const now = opts.now ?? Date.now();
    const from = now - (opts.days ?? 30) * DAY;
    const kindSql = opts.kind === undefined ? "" : " AND task_kind = ?";
    const params = [tenantId, agentId, from, now + 1, ...(opts.kind === undefined ? [] : [opts.kind])];

    const evidence = new Map<string, Mutable<Evidence>>();
    const entry = (model: string) => {
      let e = evidence.get(model);
      if (e === undefined) evidence.set(model, (e = { ...NO_EVIDENCE }));
      return e;
    };
    for (const r of this.#db
      .prepare(
        `SELECT model, COUNT(*) AS calls,
                COALESCE(SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END), 0) AS cost,
                COALESCE(SUM(CASE WHEN answer_check = 'pass' THEN 1 ELSE 0 END), 0) AS met,
                COALESCE(SUM(CASE WHEN answer_check IN ('not-json', 'missing-field') THEN 1 ELSE 0 END), 0) AS below,
                COALESCE(SUM(CASE WHEN outcome = 'ok' AND (answer_check IS NULL OR answer_check NOT IN ('cut-off', 'refusal')) THEN 1 ELSE 0 END), 0) AS finished,
                COALESCE(SUM(CASE WHEN outcome = 'error' OR answer_check IN ('cut-off', 'refusal') THEN 1 ELSE 0 END), 0) AS notFinished
         FROM calls WHERE tenant_id = ? AND agent_id = ? AND outcome != 'blocked'
           AND started_at >= ? AND started_at < ?${kindSql}
         GROUP BY model`,
      )
      .safeIntegers(true)
      .all(...params) as Record<string, bigint | string>[]) {
      const e = entry(r["model"] as string);
      e.calls += Number(r["calls"]);
      e.cost += r["cost"] as bigint;
      e.met += Number(r["met"]);
      e.below += Number(r["below"]);
      e.finished += Number(r["finished"]);
      e.notFinished += Number(r["notFinished"]);
    }

    // Reported outcomes, on the model and kind of each run's first call.
    const bar = new QualityRepository(this.#db).forAgent(tenantId, agentId).barMilli ?? DEFAULT_QUALITY_BAR_MILLI;
    for (const r of this.#db
      .prepare(
        `SELECT c.model, o.succeeded, o.quality_milli AS q, o.signal
         FROM outcomes o JOIN calls c ON c.tenant_id = o.tenant_id AND c.run_id = o.run_id AND c.id = (
           SELECT id FROM calls WHERE tenant_id = o.tenant_id AND run_id = o.run_id ORDER BY started_at, id LIMIT 1)
         WHERE o.tenant_id = ? AND c.agent_id = ? AND c.started_at >= ? AND c.started_at < ?${kindSql.replace("task_kind", "c.task_kind")}`,
      )
      .all(...params) as { model: string; succeeded: number; q: number | null; signal: string | null }[]) {
      const e = entry(r.model);
      if (r.succeeded === 1) e.finished += 1;
      else e.notFinished += 1;
      if (r.signal === "edited" || r.signal === "rejected" || r.signal === "handed-off" || (r.q !== null && r.q < bar)) e.below += 1;
      else if (r.signal === "accepted" || r.q !== null) e.met += 1;
    }

    const shape = this.#db
      .prepare(
        `SELECT COUNT(*) AS calls, COUNT(DISTINCT run_id) AS runs,
                COALESCE(SUM(CASE WHEN task_kind IS NOT NULL THEN 1 ELSE 0 END), 0) AS labelled,
                AVG(input_tokens) AS input, AVG(output_tokens) AS output,
                AVG(cache_read_tokens) AS cacheRead, AVG(cache_write_5m_tokens + cache_write_1h_tokens) AS cacheWrite
         FROM calls WHERE tenant_id = ? AND agent_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?${kindSql}`,
      )
      .get(...params) as { calls: number; runs: number; labelled: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
    const profile: TokenUsage = {
      ...ZERO_USAGE,
      inputTokens: Math.round(shape.input ?? 0),
      outputTokens: Math.round(shape.output ?? 0),
      cacheReadTokens: Math.round(shape.cacheRead ?? 0),
      cacheWrite5mTokens: Math.round(shape.cacheWrite ?? 0),
    };
    const callsPerJob = shape.runs > 0 ? shape.calls / shape.runs : 1;

    const usage = this.#db
      .prepare(
        `SELECT model, provider, COUNT(*) AS n FROM calls WHERE tenant_id = ? AND agent_id = ? AND started_at >= ? AND started_at < ?
         GROUP BY model, provider ORDER BY n DESC LIMIT 1`,
      )
      .get(tenantId, agentId, from, now + 1) as { model: string; provider: string } | undefined;
    const current = usage?.model;

    const endpoints = new EndpointsRepository(this.#db);
    const destinations = new Set<string>(endpoints.destinations(tenantId, agentId));
    const own = usage?.provider === "openai" || usage?.provider === "open" ? "openai" : "anthropic";
    destinations.add(own);

    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const add = (c: Candidate) => {
      if (seen.has(c.model)) return;
      seen.add(c.model);
      candidates.push(c);
    };
    const estimate = (model: string): Nanodollars | undefined =>
      profile.inputTokens + profile.outputTokens === 0 ? undefined : priceUsage(model, profile).cost.total;

    for (const price of listModelPrices()) {
      if (price.retired || !destinations.has(price.provider)) continue;
      add({ model: price.id, tier: price.tier, evidence: evidence.get(price.id) ?? NO_EVIDENCE, estimatedCostPerCall: estimate(price.id) });
    }
    for (const m of endpoints.models(tenantId)) {
      if (m.price === undefined || !destinations.has(`open:${m.endpointId}`)) continue;
      add({
        model: m.id,
        tier: "open",
        evidence: evidence.get(m.id) ?? NO_EVIDENCE,
        ...(profile.inputTokens + profile.outputTokens > 0 ? { estimatedCostPerCall: costOfOpen(profile, m.price).total } : {}),
      });
    }
    // The model it uses now is always a candidate, even one the catalog has retired.
    if (current !== undefined && !seen.has(current)) {
      add({ model: current, tier: findModelPrice(current)?.tier ?? "mid", evidence: evidence.get(current) ?? NO_EVIDENCE });
    }

    return {
      agentId,
      kind: opts.kind,
      current,
      callsPerJob,
      labelled: shape.labelled,
      calls: shape.calls,
      ranked: rankModels(candidates, { kind: opts.kind, current, callsPerJob, ...(opts.mode ? { mode: opts.mode } : {}) }),
    };
  }
}
