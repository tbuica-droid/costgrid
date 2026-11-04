import type { AnswerSpec, Nanodollars } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * Quality settings per agent, and the routing decision log.
 *
 * An agent's answer spec says what a good answer looks like (any format, or
 * JSON with named top-level fields); its quality bar is the reported score a
 * job needs to count as good. The decision log keeps every choice CostGrid
 * made about where or how a call was sent, with the reason.
 */

/** The bar a reported score must reach when the owner has not set one: 0.5. */
export const DEFAULT_QUALITY_BAR_MILLI = 500;
export const MAX_REQUIRED_FIELDS = 20;

export const OUTCOME_SIGNALS = ["accepted", "edited", "rejected", "handed-off"] as const;
export type OutcomeSignal = (typeof OUTCOME_SIGNALS)[number];

export interface AgentQuality {
  readonly agentId: string;
  readonly spec: AnswerSpec;
  readonly barMilli: number;
  /** False when the bar is the default rather than the owner's. */
  readonly barSet: boolean;
}

export type DecisionKind = "route" | "fallback" | "adjust" | "kept" | "not-routed";

export interface RoutingDecision {
  readonly tenantId: string;
  readonly callId: string;
  readonly agentId: string;
  readonly decidedAt: number;
  readonly kind: DecisionKind;
  readonly requestedModel: string;
  readonly chosenModel: string;
  readonly applied: boolean;
  readonly policyId?: string | undefined;
  readonly reason: string;
  readonly predictedCost?: Nanodollars | undefined;
  readonly predictedQualityMilli?: number | undefined;
  readonly confidenceMilli?: number | undefined;
  readonly rejected?: readonly { readonly model: string; readonly why: string }[] | undefined;
}

function specOf(format: string, fields: string | null): AnswerSpec {
  if (format !== "json") return { format: "any" };
  const parsed = fields === null ? [] : (JSON.parse(fields) as string[]);
  return parsed.length === 0 ? { format: "json" } : { format: "json", requiredFields: parsed };
}

export class QualityRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** One agent's settings; the defaults for an agent CostGrid has not seen. */
  forAgent(tenantId: string, agentId: string): AgentQuality {
    const row = this.#db
      .prepare(
        `SELECT answer_format AS format, required_fields AS fields, quality_bar_milli AS bar
         FROM agents WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, agentId) as { format: string; fields: string | null; bar: number | null } | undefined;
    return {
      agentId,
      spec: row === undefined ? { format: "any" } : specOf(row.format, row.fields),
      barMilli: row?.bar ?? DEFAULT_QUALITY_BAR_MILLI,
      barSet: row?.bar != null,
    };
  }

  all(tenantId: string): Map<string, AgentQuality> {
    const rows = this.#db
      .prepare(
        `SELECT id, answer_format AS format, required_fields AS fields, quality_bar_milli AS bar
         FROM agents WHERE tenant_id = ?`,
      )
      .all(tenantId) as { id: string; format: string; fields: string | null; bar: number | null }[];
    return new Map(
      rows.map((r) => [
        r.id,
        { agentId: r.id, spec: specOf(r.format, r.fields), barMilli: r.bar ?? DEFAULT_QUALITY_BAR_MILLI, barSet: r.bar !== null },
      ]),
    );
  }

  /** False when the agent does not exist. Input is checked by the caller (a write boundary). */
  set(tenantId: string, agentId: string, spec: AnswerSpec, barMilli: number | null): boolean {
    const fields = spec.format === "json" && spec.requiredFields?.length ? JSON.stringify(spec.requiredFields) : null;
    return (
      this.#db
        .prepare(
          `UPDATE agents SET answer_format = ?, required_fields = ?, quality_bar_milli = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(spec.format, fields, barMilli, tenantId, agentId).changes === 1
    );
  }

  // ------------------------------------------------------------ decisions

  recordDecision(d: RoutingDecision): void {
    this.#db
      .prepare(
        `INSERT INTO routing_decisions (
           tenant_id, call_id, agent_id, decided_at, kind, requested_model, chosen_model, applied,
           policy_id, reason, predicted_cost, predicted_quality_milli, confidence_milli, rejected
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (call_id, kind) DO NOTHING`,
      )
      .run(
        d.tenantId,
        d.callId,
        d.agentId,
        d.decidedAt,
        d.kind,
        d.requestedModel,
        d.chosenModel,
        d.applied ? 1 : 0,
        d.policyId ?? null,
        d.reason,
        d.predictedCost ?? null,
        d.predictedQualityMilli ?? null,
        d.confidenceMilli ?? null,
        d.rejected === undefined ? null : JSON.stringify(d.rejected),
      );
  }

  recentDecisions(tenantId: string, limit = 100, agentId?: string): RoutingDecision[] {
    const rows = this.#db
      .prepare(
        `SELECT call_id AS callId, agent_id AS agentId, decided_at AS decidedAt, kind,
                requested_model AS requestedModel, chosen_model AS chosenModel, applied, policy_id AS policyId,
                reason, predicted_cost AS predictedCost, predicted_quality_milli AS predictedQualityMilli,
                confidence_milli AS confidenceMilli, rejected
         FROM routing_decisions
         WHERE tenant_id = ? ${agentId === undefined ? "" : "AND agent_id = ?"}
         ORDER BY decided_at DESC LIMIT ?`,
      )
      .safeIntegers(true)
      .all(...(agentId === undefined ? [tenantId, limit] : [tenantId, agentId, limit])) as Record<string, unknown>[];
    const num = (v: unknown) => (v === null ? undefined : Number(v));
    return rows.map((r) => ({
      tenantId,
      callId: r["callId"] as string,
      agentId: r["agentId"] as string,
      decidedAt: Number(r["decidedAt"]),
      kind: r["kind"] as DecisionKind,
      requestedModel: r["requestedModel"] as string,
      chosenModel: r["chosenModel"] as string,
      applied: Number(r["applied"]) === 1,
      policyId: (r["policyId"] as string | null) ?? undefined,
      reason: r["reason"] as string,
      predictedCost: r["predictedCost"] === null ? undefined : (r["predictedCost"] as bigint),
      predictedQualityMilli: num(r["predictedQualityMilli"]),
      confidenceMilli: num(r["confidenceMilli"]),
      rejected: r["rejected"] === null ? undefined : (JSON.parse(r["rejected"] as string) as RoutingDecision["rejected"]),
    }));
  }
}
