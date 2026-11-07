import {
  labelTask,
  type RoutingMode,
  TASK_KINDS,
  type TaskKind,
  toUsdString,
  usd,
} from "@costgrid/core";
import { type Db, Predictions, type AgentPredictions } from "@costgrid/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ReadPool } from "./read-pool.js";

/**
 * "Which model is best for this agent, or this sample task?" (v3, phases 4 and 6).
 *
 *   POST /v1/costgrid/predict  { agent?, kind?, sample?: { format, request }, mode? }
 *
 * A ranked list of the models the agent may be sent to, each with predicted
 * quality, chance of finishing, cost per call and per finished job, how sure
 * the prediction is, and the evidence behind it. A sample request is labelled
 * in memory to pick the kind of task and is never stored. Nothing here routes
 * a call.
 */

export interface PredictDeps {
  readonly db: Db;
  readonly reads?: ReadPool | undefined;
  readonly identify: (request: FastifyRequest) => { tenantId: string; agentId: string } | undefined;
}

const USD = /^\d{1,9}(\.\d{1,9})?$/;
const AGENT = /^[A-Za-z0-9._:-]{1,128}$/;

function parseMode(raw: unknown): RoutingMode | string | undefined {
  if (raw === undefined) return undefined;
  const m = raw as Record<string, unknown>;
  if (m?.["kind"] === "same-quality") return { kind: "same-quality" };
  if (m?.["kind"] === "best-within-budget" && typeof m["budgetPerJobUsd"] === "string" && USD.test(m["budgetPerJobUsd"])) {
    return { kind: "best-within-budget", budgetPerJob: usd(m["budgetPerJobUsd"]) };
  }
  if (m?.["kind"] === "best-value" && typeof m["valueOfFullQualityUsd"] === "string" && USD.test(m["valueOfFullQualityUsd"])) {
    return { kind: "best-value", valueOfFullQuality: usd(m["valueOfFullQualityUsd"]) };
  }
  return "mode must be same-quality, best-within-budget with budgetPerJobUsd, or best-value with valueOfFullQualityUsd";
}

export function predictionsView(p: AgentPredictions, limit = 15) {
  const money = (n: bigint | null) => (n === null ? null : toUsdString(n, 6));
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    agent: p.agentId,
    kind: p.kind ?? null,
    current: p.current ?? null,
    callsPerJob: round(p.callsPerJob),
    labelledCalls: p.labelled,
    calls: p.calls,
    models: p.ranked.slice(0, limit).map((r) => ({
      model: r.model,
      eligible: r.eligible,
      current: r.current,
      note: r.note,
      quality: { mean: round(r.quality.mean), low: round(r.quality.low), high: round(r.quality.high) },
      finish: { mean: round(r.finish.mean), low: round(r.finish.low), high: round(r.finish.high) },
      costPerCallUsd: money(r.costPerCall),
      costPerFinishedJobUsd: money(r.costPerFinishedJob),
      costBasis: r.costBasis,
      confidence: round(r.confidence),
      evidence: r.evidence,
      prior: r.prior,
    })),
  };
}

export function registerPredict(app: FastifyInstance, deps: PredictDeps): void {
  app.post("/v1/costgrid/predict", async (request, reply) => {
    const caller = deps.identify(request);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });
    const body = (request.body ?? {}) as Record<string, unknown>;

    const agent = body["agent"] ?? caller.agentId;
    if (typeof agent !== "string" || !AGENT.test(agent)) return reply.code(400).send({ error: "agent must be an agent id" });

    let kind: TaskKind | undefined;
    if (body["kind"] !== undefined) {
      if (!(TASK_KINDS as readonly unknown[]).includes(body["kind"])) {
        return reply.code(400).send({ error: `kind must be one of ${TASK_KINDS.join(", ")}` });
      }
      kind = body["kind"] as TaskKind;
    }
    const sample = body["sample"] as Record<string, unknown> | undefined;
    if (sample !== undefined) {
      const format = sample?.["format"];
      if (format !== "anthropic" && format !== "openai") {
        return reply.code(400).send({ error: "sample.format must be anthropic or openai" });
      }
      // Read in memory to pick the kind; the sample is not kept.
      kind ??= labelTask(format, sample["request"]).kind;
    }
    const mode = parseMode(body["mode"]);
    if (typeof mode === "string") return reply.code(400).send({ error: mode });

    const now = Date.now();
    const result =
      deps.reads === undefined
        ? new Predictions(deps.db).forAgent(caller.tenantId, agent, { kind, now, ...(mode ? { mode } : {}) })
        : await deps.reads.run("predictions", caller.tenantId, agent, kind, mode, now);
    return predictionsView(result);
  });
}
