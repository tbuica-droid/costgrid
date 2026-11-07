import { type Db, Predictions, RoutingRepository, TrialsRepository } from "@costgrid/db";
import type { Alerter } from "./alerts.js";

/**
 * The router checking itself (v3, phase 6).
 *
 *   - Hourly, the per-request routing table is rebuilt from each opted-in
 *     agent's own evidence.
 *   - Weekly, each agent's predictions in use are saved; a week later they
 *     are compared with what happened. The share that fell inside their range
 *     is the agent's trust, which later predictions scale their confidence
 *     by, so the router plays safer where it was wrong. Trust below a half
 *     is told to the owner.
 *   - The grader is checked against the owner's spot checks; when they
 *     disagree too often, grades stop counting in trials, and the owner is told.
 */

const WEEK = 7 * 86_400_000;
export const LOW_TRUST = 0.5;

export function runSelfChecks(deps: { db: Db; alerter?: Alerter | undefined }, now = Date.now()): { choices: number; checked: number } {
  const { db, alerter } = deps;
  const routing = new RoutingRepository(db);
  const choices = routing.buildAll(now);
  let checked = 0;

  const tenants = db.prepare("SELECT id FROM tenants").all() as { id: string }[];
  for (const { id: tenantId } of tenants) {
    const last = db.prepare("SELECT MAX(made_at) AS at FROM prediction_checks WHERE tenant_id = ?").get(tenantId) as { at: number | null };
    if (last.at === null || now - last.at >= WEEK) routing.snapshot(tenantId, now);
    const result = routing.check(tenantId, now);
    checked += result.checked;

    if (result.checked > 0) {
      const agents = db
        .prepare("SELECT DISTINCT agent_id AS id FROM prediction_checks WHERE tenant_id = ? AND within IS NOT NULL")
        .all(tenantId) as { id: string }[];
      for (const { id } of agents) {
        const trust = new Predictions(db).trust(tenantId, id);
        if (trust >= LOW_TRUST) continue;
        alerter?.raise(
          tenantId,
          {
            kind: "switched-back",
            dedupeKey: `trust:${id}:${Math.floor(now / WEEK)}`,
            subject: id,
            message:
              `CostGrid's predictions for ${id} were right only ${Math.round(trust * 100)}% of the time recently, ` +
              "so it now treats them with more caution and is slower to suggest a switch.",
          },
          now,
        );
      }
    }

    const grader = new TrialsRepository(db).graderAgreement(tenantId);
    if (!grader.trusted) {
      alerter?.raise(
        tenantId,
        {
          kind: "switched-back",
          dedupeKey: `grader:${Math.floor(now / WEEK)}`,
          subject: "grading",
          message:
            `The grader agreed with your spot checks only ${Math.round((grader.rate ?? 0) * 100)}% of the time ` +
            `(${grader.agreed} of ${grader.checked}), so its verdicts no longer count in trials.`,
        },
        now,
      );
    }
  }
  return { choices, checked };
}
