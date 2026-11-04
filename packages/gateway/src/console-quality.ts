import { toUsdString } from "@costgrid/core";
import {
  type AccountsRepository,
  type Db,
  MAX_REQUIRED_FIELDS,
  QualityRepository,
  type RoutingDecision,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";

/**
 * Quality settings and the decision log, on the console.
 *
 * Per agent, the owner says what a good answer looks like (any format, or JSON
 * with named top-level fields) and the score a reported job needs to count as
 * good. The decision log lists every choice CostGrid made about where or how a
 * call was sent, newest first, with its reason.
 */

export interface QualityDeps {
  readonly db: Db;
  readonly accounts: AccountsRepository;
}

/** A JSON field name: short, one line, nothing that could carry content. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

function decisionView(d: RoutingDecision) {
  return {
    callId: d.callId,
    agentId: d.agentId,
    decidedAt: d.decidedAt,
    kind: d.kind,
    requestedModel: d.requestedModel,
    chosenModel: d.chosenModel,
    applied: d.applied,
    reason: d.reason,
    predictedCostUsd: d.predictedCost === undefined ? null : toUsdString(d.predictedCost, 6),
    predictedQuality: d.predictedQualityMilli === undefined ? null : d.predictedQualityMilli / 1000,
    confidence: d.confidenceMilli === undefined ? null : d.confidenceMilli / 1000,
    rejected: d.rejected ?? [],
  };
}

export function registerQuality(app: FastifyInstance, deps: QualityDeps): void {
  const { accounts, db } = deps;
  const { requireRole } = createGuards(accounts);
  const quality = new QualityRepository(db);

  app.get("/console/:tenantId/quality", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;
    const agents = db
      .prepare("SELECT id, name FROM agents WHERE tenant_id = ? ORDER BY COALESCE(name, id) LIMIT 500")
      .all(tenantId) as { id: string; name: string | null }[];
    const settings = quality.all(tenantId);
    return {
      agents: agents.map((a) => {
        const q = settings.get(a.id);
        return {
          agentId: a.id,
          name: a.name,
          format: q?.spec.format ?? "any",
          requiredFields: q?.spec.requiredFields ?? [],
          bar: (q?.barMilli ?? 500) / 1000,
          barSet: q?.barSet ?? false,
        };
      }),
    };
  });

  /** Set one agent's answer spec and bar. This is a write boundary. */
  app.put("/console/:tenantId/quality/:agentId", async (request: ConsoleRequest, reply) => {
    const { tenantId, agentId } = request.params as { tenantId: string; agentId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const format = body["format"];
    if (format !== "any" && format !== "json") return reply.code(400).send({ error: "format must be any or json" });
    const raw = body["requiredFields"] ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_REQUIRED_FIELDS || !raw.every((f) => typeof f === "string" && FIELD.test(f))) {
      return reply.code(400).send({
        error: `required fields must be up to ${MAX_REQUIRED_FIELDS} names made of letters, digits, _ . or -`,
      });
    }
    const bar = body["bar"];
    if (bar !== null && bar !== undefined && (typeof bar !== "number" || !(bar >= 0 && bar <= 1))) {
      return reply.code(400).send({ error: "the bar must be a number from 0 to 1" });
    }
    const fields = [...new Set(raw as string[])];
    const barMilli = typeof bar === "number" ? Math.round(bar * 1000) : null;
    const ok = quality.set(
      tenantId,
      agentId,
      format === "json" ? { format, ...(fields.length ? { requiredFields: fields } : {}) } : { format },
      barMilli,
    );
    if (!ok) return reply.code(404).send({ error: "agent not found" });
    accounts.audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "agent.quality",
      subject: agentId,
      detail: { format, requiredFields: fields.join(","), barMilli },
    });
    return { agentId, format, requiredFields: fields, bar: (barMilli ?? 500) / 1000, barSet: barMilli !== null };
  });

  app.get("/console/:tenantId/decisions", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const agentId = typeof query["agent"] === "string" && query["agent"] !== "" ? query["agent"].slice(0, 128) : undefined;
    return { decisions: quality.recentDecisions(tenantId, 100, agentId).map(decisionView) };
  });
}
