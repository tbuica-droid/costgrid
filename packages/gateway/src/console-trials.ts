import { toUsdString } from "@costgrid/core";
import {
  type AccountsRepository,
  type ArmStats,
  type Db,
  Predictions,
  TrialsRepository,
} from "@costgrid/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";
import type { SpotCheckMemory } from "./grading.js";
import { applyTrial } from "./trial-review.js";

/**
 * Trials on the console (v3, phase 5): what is being tested on which agent,
 * how each arm is doing, suggestions for what to test next, approving a
 * passed trial, per-agent safety settings, grading and spot checks.
 *
 * Spot checks are blind: the owner gives a verdict before seeing the
 * grader's, so the comparison in phase 6 is fair.
 */

export interface TrialsDeps {
  readonly db: Db;
  readonly accounts: AccountsRepository;
  readonly spotChecks: SpotCheckMemory;
}

const money = (n: bigint | null) => (n === null ? null : toUsdString(n, 6));
const round = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
const arm = (s: ArmStats) => ({
  jobs: s.jobs,
  finishedShare: round(s.finishedShare),
  qualityShare: round(s.qualityShare),
  errorRate: round(s.errorRate),
  costPerGoodJobUsd: money(s.costPerGoodJob),
});

export function registerTrials(app: FastifyInstance, deps: TrialsDeps): void {
  const { accounts, db, spotChecks } = deps;
  const { requireRole } = createGuards(accounts);
  const trials = new TrialsRepository(db);
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });
  const by = (user: { id: string; email: string }) => ({ kind: "user" as const, id: user.id, label: user.email });

  app.get("/console/:tenantId/trials", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;
    const now = Date.now();
    const agents = db
      .prepare(
        `SELECT id, name FROM agents WHERE tenant_id = ? AND last_seen_at IS NOT NULL AND last_seen_at >= ?
         ORDER BY last_seen_at DESC LIMIT 20`,
      )
      .all(tenantId, now - 30 * 86_400_000) as { id: string; name: string | null }[];
    const predictions = new Predictions(db);
    const all = trials.list(tenantId);
    return {
      grading: trials.grading(tenantId),
      trials: all.map((t) => {
        const j = t.status === "running" || t.status === "passed" ? trials.judge(tenantId, t) : undefined;
        return {
          ...t,
          ...(j ? { candidate: arm(j.candidate), baseline: arm(j.baseline), grades: j.grades, progress: j.why } : {}),
        };
      }),
      agents: agents.map((a) => {
        const settings = trials.agentSettings(tenantId, a.id);
        const p = predictions.forAgent(tenantId, a.id, { now });
        const busy = all.some((t) => t.agentId === a.id && t.status === "running");
        // The cheapest model predicted as good as the current one, to test next.
        const next = busy || settings.critical ? undefined : p.ranked.find((r) => r.eligible && !r.current);
        return {
          ...a,
          ...settings,
          canSwitchOnItsOwn: trials.hasApplied(tenantId, a.id),
          current: p.current ?? null,
          suggestion:
            next === undefined || p.current === undefined
              ? null
              : {
                  model: next.model,
                  costPerFinishedJobUsd: money(next.costPerFinishedJob),
                  currentCostPerFinishedJobUsd: money(p.ranked.find((r) => r.current)?.costPerFinishedJob ?? null),
                  quality: round(next.quality.mean),
                  confidence: round(next.confidence),
                  prior: next.prior,
                },
        };
      }),
      // Blind: the grader's verdict is not sent until the owner has given theirs.
      spotChecks: trials.spotChecks(tenantId).map((s) => ({
        callId: s.callId,
        runId: s.runId,
        trialId: s.trialId,
        gradedAt: s.gradedAt,
        answersInMemory: spotChecks.get(tenantId, s.callId) !== undefined,
      })),
    };
  });

  app.post("/console/:tenantId/trials", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const agentId = typeof body["agentId"] === "string" ? body["agentId"] : "";
    const candidate = typeof body["candidateModel"] === "string" ? body["candidateModel"] : "";
    const sharePct = body["sharePct"] ?? 5;
    if (typeof sharePct !== "number" || !(sharePct >= 1 && sharePct <= 20)) return bad(reply, "the share must be from 1% to 20% (D16 suggests about 5%)");
    const minJobs = body["minJobs"] ?? 100;
    if (typeof minJobs !== "number" || !Number.isInteger(minJobs) || minJobs < 20 || minJobs > 100_000) {
      return bad(reply, "the minimum must be a whole number of jobs, at least 20");
    }
    const p = new Predictions(db).forAgent(tenantId, agentId);
    if (p.current === undefined) return bad(reply, "this agent has sent no calls through CostGrid yet");
    if (!p.ranked.some((r) => r.model === candidate)) {
      return bad(reply, "that model is not one this agent may be sent to: opt it in, and price it if it is an open model");
    }
    const started = trials.start(tenantId, {
      agentId,
      baselineModel: p.current,
      candidateModel: candidate,
      shareMilli: Math.round(sharePct * 10),
      minJobs,
    });
    if (typeof started === "string") return bad(reply, started);
    accounts.audit.record(tenantId, {
      actor: by(actor.user),
      action: "trial.started",
      subject: started.id,
      detail: { agent: agentId, from: p.current, to: candidate, sharePct, minJobs },
    });
    return reply.code(201).send(started);
  });

  app.post("/console/:tenantId/trials/:id/:action", async (request: ConsoleRequest, reply) => {
    const { tenantId, id, action } = request.params as { tenantId: string; id: string; action: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const trial = trials.get(tenantId, id);
    if (trial === undefined) return reply.code(404).send({ error: "no such trial" });
    if (action === "stop") {
      if (trial.status !== "running") return bad(reply, "only a running trial can be stopped");
      trials.setStatus(tenantId, id, "stopped", "stopped by the owner");
      accounts.audit.record(tenantId, { actor: by(actor.user), action: "trial.stopped", subject: id, detail: { agent: trial.agentId } });
      return { id, status: "stopped" };
    }
    if (action === "approve") {
      if (trial.status !== "passed") return bad(reply, "only a passed trial can be applied");
      const policyId = applyTrial({ db, audit: accounts.audit }, tenantId, trial, by(actor.user));
      return { id, status: "applied", policyId };
    }
    return reply.code(404).send({ error: "unknown action" });
  });

  app.put("/console/:tenantId/agents/:agentId/trial-settings", async (request: ConsoleRequest, reply) => {
    const { tenantId, agentId } = request.params as { tenantId: string; agentId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const critical = body["critical"];
    const switching = body["switching"];
    if (critical !== undefined && typeof critical !== "boolean") return bad(reply, "critical must be true or false");
    if (switching !== undefined && switching !== "suggest" && switching !== "auto") return bad(reply, "switching must be suggest or auto");
    // D14: an agent may switch on its own only after a trial the owner applied.
    if (switching === "auto" && !trials.hasApplied(tenantId, agentId)) {
      return bad(reply, "approve one passed trial for this agent first; then it may switch on its own");
    }
    const ok = trials.setAgentSettings(tenantId, agentId, {
      ...(typeof critical === "boolean" ? { critical } : {}),
      ...(switching === "suggest" || switching === "auto" ? { switching } : {}),
    });
    if (!ok) return reply.code(404).send({ error: "agent not found" });
    // Marking work critical ends any test on it at once.
    const running = critical === true ? trials.runningFor(tenantId, agentId) : undefined;
    if (running !== undefined) trials.setStatus(tenantId, running.id, "stopped", "the agent's work was marked critical");
    accounts.audit.record(tenantId, {
      actor: by(actor.user),
      action: "agent.trial-settings",
      subject: agentId,
      detail: { critical: typeof critical === "boolean" ? critical : null, switching: typeof switching === "string" ? switching : null },
    });
    return trials.agentSettings(tenantId, agentId);
  });

  app.put("/console/:tenantId/grading", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const enabled = body["enabled"];
    const sharePct = body["sharePct"] ?? 1.5;
    if (typeof enabled !== "boolean") return bad(reply, "enabled must be true or false");
    if (typeof sharePct !== "number" || !(sharePct >= 1 && sharePct <= 2)) return bad(reply, "grading samples 1% to 2% of trial jobs");
    trials.setGrading(tenantId, enabled, Math.round(sharePct * 10));
    accounts.audit.record(tenantId, { actor: by(actor.user), action: "grading.set", subject: tenantId, detail: { enabled, sharePct } });
    return trials.grading(tenantId);
  });

  /** The two answers a grader compared, while still in memory. Owners only, and never the grader's verdict first. */
  app.get("/console/:tenantId/spot-checks/:callId", async (request: ConsoleRequest, reply) => {
    const { tenantId, callId } = request.params as { tenantId: string; callId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;
    const pair = spotChecks.get(tenantId, callId);
    if (pair === undefined) return reply.code(404).send({ error: "those answers are no longer in memory; look the job up in your own records" });
    // Shown as A and B, in a fixed order that does not reveal which arm is which.
    const swap = callId.charCodeAt(callId.length - 1) % 2 === 0;
    return { task: pair.task, a: swap ? pair.baseline : pair.candidate, b: swap ? pair.candidate : pair.baseline };
  });

  app.put("/console/:tenantId/spot-checks/:callId", async (request: ConsoleRequest, reply) => {
    const { tenantId, callId } = request.params as { tenantId: string; callId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const raw = ((request.body ?? {}) as Record<string, unknown>)["verdict"];
    let verdict: "candidate" | "baseline" | "tie" | "unsure";
    if (raw === "a" || raw === "b") {
      const swap = callId.charCodeAt(callId.length - 1) % 2 === 0;
      verdict = (raw === "a") !== swap ? "candidate" : "baseline";
    } else if (raw === "candidate" || raw === "baseline" || raw === "tie" || raw === "unsure") verdict = raw;
    else return bad(reply, "verdict must be a, b, tie or unsure");
    if (!trials.setOwnerVerdict(tenantId, callId, verdict)) return reply.code(404).send({ error: "no such graded job" });
    spotChecks.forget(tenantId, callId);
    accounts.audit.record(tenantId, { actor: by(actor.user), action: "grading.spot-check", subject: callId, detail: { verdict } });
    return { callId, verdict };
  });
}
