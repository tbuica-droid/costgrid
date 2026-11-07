import { type Nanodollars, TASK_KINDS, type TaskKind } from "@costgrid/core";
import type { Db } from "./database.js";
import { Predictions } from "./predictions.js";

/**
 * Per-request routing and the self-checks behind it (v3, phase 6).
 *
 * The routing table is built in the background, per agent that opted in to
 * per-request routing, and per kind of task it does: the cheapest model that
 * is "same quality" as the current one on the agent's own measured evidence,
 * with at least `MIN_JUDGED_FOR_ROUTING` judged jobs on that kind. A prior
 * never chooses a model (D8). The proxy only reads the table.
 *
 * Each week the predictions in use are saved, and a week later compared with
 * what happened. The share that fell inside their range is the agent's trust,
 * which scales how sure later predictions say they are.
 */

export const MIN_JUDGED_FOR_ROUTING = 30;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

export interface RouteChoice {
  readonly agentId: string;
  readonly kind: TaskKind;
  readonly model: string;
  readonly predictedCost: Nanodollars | null;
  readonly predictedQualityMilli: number;
  readonly confidenceMilli: number;
  readonly evidenceJobs: number;
  readonly rejected: readonly { model: string; why: string }[];
}

export interface RoutingSettings {
  readonly perRequest: boolean;
  readonly stepUpModel: string | null;
}

export class RoutingRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  settings(tenantId: string, agentId: string): RoutingSettings {
    const row = this.#db
      .prepare("SELECT per_request AS p, step_up_model AS s FROM agents WHERE tenant_id = ? AND id = ?")
      .get(tenantId, agentId) as { p: number; s: string | null } | undefined;
    return { perRequest: row?.p === 1, stepUpModel: row?.s ?? null };
  }

  setSettings(tenantId: string, agentId: string, s: Partial<RoutingSettings>): boolean {
    const current = this.settings(tenantId, agentId);
    const perRequest = s.perRequest ?? current.perRequest;
    const changed =
      this.#db
        .prepare("UPDATE agents SET per_request = ?, step_up_model = ? WHERE tenant_id = ? AND id = ?")
        .run(perRequest ? 1 : 0, s.stepUpModel === undefined ? current.stepUpModel : s.stepUpModel, tenantId, agentId).changes === 1;
    if (changed && !perRequest) this.#db.prepare("DELETE FROM routing_table WHERE tenant_id = ? AND agent_id = ?").run(tenantId, agentId);
    return changed;
  }

  /** Every agent's step-up model and routing-table choices, for the proxy's cache. */
  forProxy(): { steps: Map<string, string>; choices: Map<string, RouteChoice> } {
    const steps = new Map<string, string>();
    for (const r of this.#db
      .prepare("SELECT tenant_id AS t, id, step_up_model AS s FROM agents WHERE step_up_model IS NOT NULL")
      .all() as { t: string; id: string; s: string }[]) {
      steps.set(`${r.t}|${r.id}`, r.s);
    }
    const choices = new Map<string, RouteChoice>();
    for (const r of this.#db
      .prepare(
        `SELECT tenant_id AS t, agent_id AS agentId, task_kind AS kind, model, predicted_cost AS cost,
                predicted_quality_milli AS q, confidence_milli AS c, evidence_jobs AS n, rejected
         FROM routing_table`,
      )
      .safeIntegers(true)
      .all() as Record<string, unknown>[]) {
      choices.set(`${r["t"]}|${r["agentId"]}|${r["kind"]}`, {
        agentId: r["agentId"] as string,
        kind: r["kind"] as TaskKind,
        model: r["model"] as string,
        predictedCost: r["cost"] === null ? null : (r["cost"] as bigint),
        predictedQualityMilli: Number(r["q"]),
        confidenceMilli: Number(r["c"]),
        evidenceJobs: Number(r["n"]),
        rejected: JSON.parse((r["rejected"] as string | null) ?? "[]"),
      });
    }
    return { steps, choices };
  }

  /** Rebuild the table for every agent that opted in. Returns the number of choices made. */
  buildAll(now = Date.now()): number {
    const agents = this.#db
      .prepare("SELECT tenant_id AS t, id FROM agents WHERE per_request = 1")
      .all() as { t: string; id: string }[];
    let made = 0;
    const predictions = new Predictions(this.#db);
    for (const { t, id } of agents) {
      this.#db.prepare("DELETE FROM routing_table WHERE tenant_id = ? AND agent_id = ?").run(t, id);
      for (const kind of TASK_KINDS) {
        const p = predictions.forAgent(t, id, { kind, now });
        if (p.current === undefined) continue;
        // Measured on this kind, with enough judged jobs: never a prior (D8).
        const proven = p.ranked.filter((r) => r.eligible && r.costBasis === "measured" && r.evidence.judged >= MIN_JUDGED_FOR_ROUTING);
        const best = proven[0];
        if (best === undefined || best.current) continue;
        const rejected = p.ranked
          .filter((r) => r.model !== best.model)
          .slice(0, 5)
          .map((r) => ({
            model: r.model,
            why: !r.eligible ? r.note : r.costBasis !== "measured" || r.evidence.judged < MIN_JUDGED_FOR_ROUTING ? "not enough of its own evidence on this kind" : "dearer per finished job",
          }));
        this.#db
          .prepare(
            `INSERT INTO routing_table (tenant_id, agent_id, task_kind, model, predicted_cost, predicted_quality_milli,
               confidence_milli, evidence_jobs, rejected, built_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            t,
            id,
            kind,
            best.model,
            best.costPerCall,
            Math.round(best.quality.mean * 1000),
            Math.round(best.confidence * 1000),
            best.evidence.judged,
            JSON.stringify(rejected),
            now,
          );
        made += 1;
      }
    }
    return made;
  }

  // ---------------------------------------------------------- self-check

  /** Save this week's predictions for the model each agent uses, per kind. */
  snapshot(tenantId: string, now = Date.now()): number {
    const rows = this.#db
      .prepare(
        `SELECT agent_id AS agentId, task_kind AS kind, COUNT(*) AS n FROM calls
         WHERE tenant_id = ? AND task_kind IS NOT NULL AND purpose = 'work' AND started_at >= ?
         GROUP BY agent_id, task_kind HAVING n >= 10`,
      )
      .all(tenantId, now - WEEK) as { agentId: string; kind: TaskKind }[];
    const predictions = new Predictions(this.#db);
    let saved = 0;
    for (const { agentId, kind } of rows) {
      const p = predictions.forAgent(tenantId, agentId, { kind, now });
      const current = p.ranked.find((r) => r.current);
      if (current === undefined) continue;
      this.#db
        .prepare(
          `INSERT INTO prediction_checks (tenant_id, agent_id, task_kind, model, made_at,
             predicted_quality_milli, low_milli, high_milli, predicted_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, agent_id, task_kind, model, made_at) DO NOTHING`,
        )
        .run(
          tenantId,
          agentId,
          kind,
          current.model,
          now,
          Math.round(current.quality.mean * 1000),
          Math.round(current.quality.low * 1000),
          Math.round(current.quality.high * 1000),
          current.costPerCall,
        );
      saved += 1;
    }
    return saved;
  }

  /** Compare predictions made at least a week ago with the week that followed. */
  check(tenantId: string, now = Date.now()): { checked: number; outside: number } {
    const due = this.#db
      .prepare(
        `SELECT agent_id AS agentId, task_kind AS kind, model, made_at AS madeAt, low_milli AS low, high_milli AS high
         FROM prediction_checks WHERE tenant_id = ? AND checked_at IS NULL AND made_at <= ?`,
      )
      .all(tenantId, now - WEEK) as { agentId: string; kind: string; model: string; madeAt: number; low: number; high: number }[];
    let checked = 0;
    let outside = 0;
    for (const d of due) {
      const actual = this.#db
        .prepare(
          `SELECT COUNT(*) AS calls, COALESCE(SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END), 0) AS cost,
                  COALESCE(SUM(CASE WHEN answer_check = 'pass' THEN 1 ELSE 0 END), 0) AS met,
                  COALESCE(SUM(CASE WHEN answer_check IN ('not-json', 'missing-field') THEN 1 ELSE 0 END), 0) AS below
           FROM calls WHERE tenant_id = ? AND agent_id = ? AND task_kind = ? AND model = ? AND purpose = 'work'
             AND started_at >= ? AND started_at < ?`,
        )
        .safeIntegers(true)
        .get(tenantId, d.agentId, d.kind, d.model, d.madeAt, d.madeAt + WEEK) as { calls: bigint; cost: bigint; met: bigint; below: bigint };
      const judged = Number(actual.met + actual.below);
      // Too little to judge the prediction by: checked, but counted neither way.
      const quality = judged >= 10 ? Math.round((Number(actual.met) / judged) * 1000) : null;
      const within = quality === null ? null : quality >= d.low && quality <= d.high ? 1 : 0;
      this.#db
        .prepare(
          `UPDATE prediction_checks SET actual_quality_milli = ?, actual_cost = ?, judged = ?, within = ?, checked_at = ?
           WHERE tenant_id = ? AND agent_id = ? AND task_kind = ? AND model = ? AND made_at = ?`,
        )
        .run(
          quality,
          actual.calls === 0n ? null : actual.cost / actual.calls,
          judged,
          within,
          now,
          tenantId,
          d.agentId,
          d.kind,
          d.model,
          d.madeAt,
        );
      checked += 1;
      if (within === 0) outside += 1;
    }
    return { checked, outside };
  }

  /** The latest checks, for the owner. */
  checks(tenantId: string, limit = 20): Record<string, unknown>[] {
    return this.#db
      .prepare(
        `SELECT agent_id AS agentId, task_kind AS kind, model, made_at AS madeAt, predicted_quality_milli AS predicted,
                low_milli AS low, high_milli AS high, actual_quality_milli AS actual, judged, within, checked_at AS checkedAt
         FROM prediction_checks WHERE tenant_id = ? AND checked_at IS NOT NULL ORDER BY checked_at DESC LIMIT ?`,
      )
      .all(tenantId, limit) as Record<string, unknown>[];
  }
}
