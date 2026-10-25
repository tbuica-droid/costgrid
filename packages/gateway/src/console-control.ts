import { toUsdString, usd } from "@costgrid/core";
import { type AccountsRepository, ControlRepository, type Db, type KeyAction, SourcesRepository } from "@costgrid/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";
import { bodyOf, by } from "./console-fields.js";
import { ControlError, type KeyControl, splitSources } from "./key-control.js";

/**
 * View and control on the Limits screen: pause or resume an agent's Claude
 * keys, set its monthly cap, and see how long each stop took.
 *
 * Everyone in the organisation can read; only an owner can act, and only on
 * View and control. Pausing goes to the provider with the stored admin key.
 */

export interface ControlDeps {
  readonly db: Db;
  readonly accounts: AccountsRepository;
  readonly keyControl: KeyControl;
  /** Whether this install can keep an admin key (the desktop keychain). */
  readonly canStoreKeys: boolean;
}

const MAX_CAP_USD = 1_000_000;

function actionView(a: KeyAction) {
  return {
    agentId: a.agentId,
    provider: a.provider,
    keyId: a.keyId,
    action: a.action,
    reason: a.reason,
    requestedAt: a.requestedAt,
    finishedAt: a.finishedAt,
    ok: a.ok,
    error: a.error,
    // Measured stop time, in parts: how far behind the usage report was when
    // the cap was seen, and how long the provider took to act.
    reportLagMs: a.usageThrough === null ? null : Math.max(0, a.requestedAt - a.usageThrough),
    actionMs: a.finishedAt === null ? null : a.finishedAt - a.requestedAt,
  };
}

export function registerControl(app: FastifyInstance, deps: ControlDeps): void {
  const { requireRole } = createGuards(deps.accounts);
  const control = new ControlRepository(deps.db);
  const sources = new SourcesRepository(deps.db);
  const { keyControl } = deps;

  /**
   * The owner, on View and control, or a reply saying why not. Resuming is
   * allowed on any tier: it only undoes what CostGrid did, and keys must never
   * be left off because the tier changed.
   */
  function owner(request: ConsoleRequest, reply: FastifyReply, tenantId: string, anyTier = false) {
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return undefined;
    if (!anyTier && control.tierOf(tenantId) !== "control") {
      void reply.code(403).send({ error: "Pausing keys and caps are part of View and control, which is not on for this organisation." });
      return undefined;
    }
    return actor;
  }

  const agentExists = (tenantId: string, agentId: string) =>
    deps.db.prepare("SELECT 1 FROM agents WHERE tenant_id = ? AND id = ?").get(tenantId, agentId) !== undefined;

  const failed = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ControlError) return reply.code(409).send({ error: error.message });
    throw error;
  };

  app.get("/console/:tenantId/control", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;
    const now = Date.now();
    const caps = control.caps(tenantId);
    const paused = control.pausedKeys(tenantId);
    const known = [...keyControl.monthToDate(tenantId, now).values()];
    const agents = known.map(({ agent, spent, usageThrough }) => {
      const split = splitSources(agent.sources);
      const cap = caps.get(agent.id);
      const source = (s: (typeof agent.sources)[number]) => ({ provider: s.provider, kind: s.kind, id: s.id, label: s.label });
      return {
        id: agent.id,
        name: agent.name,
        capUsd: cap ? toUsdString(cap.monthlyCap, 2) : null,
        spentUsd: toUsdString(spent, 2),
        usageThrough,
        pausable: split.pausable.map(source),
        notPausable: split.notPausable.map(source),
        paused: paused.filter((p) => p.agentId === agent.id).map((p) => ({ keyId: p.keyId, since: p.requestedAt, reason: p.reason })),
      };
    });
    // Keys still off for an agent that has since been removed: shown so they can be resumed.
    const listed = new Set(known.map((k) => k.agent.id));
    const orphaned = [...new Set(paused.filter((p) => !listed.has(p.agentId)).map((p) => p.agentId))].map((agentId) => ({
      id: agentId,
      paused: paused.filter((p) => p.agentId === agentId).map((p) => ({ keyId: p.keyId, since: p.requestedAt, reason: p.reason })),
    }));
    return {
      tier: control.tierOf(tenantId),
      orphaned,
      month: new Date(now).toISOString().slice(0, 7),
      adminKeyConnected: deps.canStoreKeys && sources.adminKeys(tenantId).some((k) => k.provider === "anthropic"),
      agents,
      history: control.history(tenantId, 30).map(actionView),
    };
  });

  for (const action of ["pause", "resume"] as const) {
    app.post(`/console/:tenantId/agents/:agentId/${action}`, async (request: ConsoleRequest, reply) => {
      const { tenantId, agentId } = request.params as { tenantId: string; agentId: string };
      const actor = owner(request, reply, tenantId, action === "resume");
      if (!actor) return;
      if (action === "pause" && !agentExists(tenantId, agentId)) return reply.code(404).send({ error: "no such agent" });
      try {
        return action === "pause"
          ? await keyControl.pause(tenantId, agentId, { actor: by(actor.user), reason: "owner" })
          : await keyControl.resume(tenantId, agentId, by(actor.user));
      } catch (error) {
        return failed(reply, error);
      }
    });
  }

  app.put("/console/:tenantId/agents/:agentId/cap", async (request: ConsoleRequest, reply) => {
    const { tenantId, agentId } = request.params as { tenantId: string; agentId: string };
    const actor = owner(request, reply, tenantId);
    if (!actor) return;
    const body = bodyOf(request);
    let cap: bigint | null = null;
    if (body["clear"] !== true) {
      const raw = body["monthlyUsd"];
      if (typeof raw !== "string" || !/^\d{1,7}(\.\d{1,2})?$/.test(raw.trim()) || Number(raw) <= 0 || Number(raw) > MAX_CAP_USD) {
        return reply.code(400).send({ error: "the cap must be a number of dollars a month, like 200 or 1500" });
      }
      cap = usd(raw.trim());
    }
    if (!control.setCap(tenantId, agentId, cap)) return reply.code(404).send({ error: "no such agent" });
    deps.accounts.audit.record(tenantId, {
      actor: by(actor.user),
      action: "control.cap",
      subject: agentId,
      detail: { monthlyUsd: cap === null ? null : toUsdString(cap, 2) },
    });
    // An agent already past a new cap is paused now, not at the next sync.
    if (cap !== null) await keyControl.checkCaps(tenantId).catch(() => undefined);
    return { ok: true };
  });
}
