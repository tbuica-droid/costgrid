import { toUsdString } from "@costgrid/core";
import {
  type AccountsRepository,
  type AgentRow,
  type AgentsRepository,
  isSourceKind,
  type Metered,
  type SourceKey,
  SYSTEM_ACTOR,
} from "@costgrid/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";
import { bodyOf, by, CONTROL, rangeOf, readName, readPurpose, readSourceId, sourceView } from "./console-fields.js";
import { importerFor } from "./importers/index.js";

/**
 * Step 3 of setup: say which agent uses each provider key, workspace or project.
 *
 * An agent is one job the owner's AI does. The owner names it, picks what it
 * is for, and puts the sources it uses on it, or marks a source as shared by
 * several agents, in which case its cost belongs to none of them. The same
 * Claude key seen in a usage file and through the admin API is matched by
 * name, and the owner can undo that.
 *
 * Imported provider usage and metered proxy cost are separate fields here and
 * stay separate on screen: never one number made of both.
 */

export interface AgentDeps {
  readonly accounts: AccountsRepository;
  readonly agents: AgentsRepository;
}

/** Proxy agent ids come from request headers, so they are free text; this only bounds them. */
const MAX_AGENT_ID = 200;

const money = (nano: bigint): string => toUsdString(nano, 6);
const meteredView = (m: Metered) => ({ costUsd: money(m.costNano), calls: m.calls });

function agentView(a: AgentRow) {
  return {
    id: a.id,
    name: a.name,
    purposeId: a.purposeId,
    purposeVersion: a.purposeVersion,
    origin: a.origin,
    lastSeenAt: a.lastSeenAt,
    sources: a.sources.map(sourceView),
    imported: { costUsd: money(a.imported.costNano), estimatedUsd: money(a.imported.estimatedNano) },
    metered: meteredView(a.metered),
  };
}

function readAgentId(raw: unknown): string | undefined {
  return typeof raw === "string" && raw !== "" && raw.length <= MAX_AGENT_ID && !CONTROL.test(raw) ? raw : undefined;
}

const keyOf = (s: SourceKey): string => `${s.provider}:${s.kind}:${s.id}`;

export function registerAgents(app: FastifyInstance, deps: AgentDeps): void {
  const { accounts, agents } = deps;
  const { audit } = accounts;
  const { requireRole } = createGuards(accounts);

  /** Carry each decided source's agent over to its undecided twin, and say so in the audit log. */
  function matchTwins(tenantId: string): ReturnType<AgentsRepository["matchTwins"]> {
    const matched = agents.matchTwins(tenantId);
    for (const m of matched) {
      audit.record(tenantId, {
        actor: SYSTEM_ACTOR,
        action: "source.matched",
        subject: keyOf(m.source),
        detail: { agentId: m.agentId, shared: m.shared },
      });
    }
    return matched;
  }

  // -------------------------------------------------------------- list

  app.get("/console/:tenantId/agents", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId, "owner")) return;
    const range = rangeOf(request);
    if ("error" in range) return reply.code(400).send(range);

    // A usage file or sync since the last visit may have brought in a twin.
    matchTwins(tenantId);
    const view = agents.view(tenantId, range);
    return {
      agents: view.agents.map(agentView),
      unassigned: view.unassigned.map(sourceView),
      shared: view.shared.map(sourceView),
      proxyOnly: view.proxyOnly.map((p) => ({ id: p.id, lastSeenAt: p.lastSeenAt, metered: meteredView(p.metered) })),
    };
  });

  // ------------------------------------------------------------ agents

  app.post("/console/:tenantId/agents", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = bodyOf(request);
    const name = readName(body["name"]);
    if (typeof name !== "string") return reply.code(400).send(name);
    let purpose: { id: string; version?: string } | undefined;
    if (body["purposeId"] !== undefined) {
      const read = readPurpose(body["purposeId"]);
      if ("error" in read) return reply.code(400).send(read);
      if (read.id !== "") purpose = read;
    }
    let linkProxyId: string | undefined;
    if (body["linkProxyId"] !== undefined) {
      linkProxyId = readAgentId(body["linkProxyId"]);
      if (linkProxyId === undefined) return reply.code(400).send({ error: "linkProxyId is not an agent id" });
    }

    const id = agents.create(tenantId, {
      name,
      ...(purpose !== undefined ? { purposeId: purpose.id, purposeVersion: purpose.version } : {}),
      ...(linkProxyId !== undefined ? { linkProxyId } : {}),
    });
    if (id === undefined) {
      return reply.code(404).send({ error: "no unnamed agent with that id has sent traffic through CostGrid" });
    }
    audit.record(tenantId, {
      actor: by(actor.user),
      action: "agent.created",
      subject: id,
      detail: { name, purposeId: purpose?.id ?? null, linked: linkProxyId !== undefined },
    });
    return reply.code(201).send({ id });
  });

  app.patch("/console/:tenantId/agents/:agentId", async (request: ConsoleRequest, reply) => {
    const params = request.params as { tenantId: string; agentId: string };
    const actor = requireRole(request, reply, params.tenantId, "owner");
    if (!actor) return;
    const agentId = readAgentId(params.agentId);
    if (agentId === undefined) return reply.code(400).send({ error: "not an agent id" });

    const body = bodyOf(request);
    const change: { name?: string; purposeId?: string; purposeVersion?: string } = {};
    if (body["name"] !== undefined) {
      const name = readName(body["name"]);
      if (typeof name !== "string") return reply.code(400).send(name);
      change.name = name;
    }
    if (body["purposeId"] !== undefined) {
      const purpose = readPurpose(body["purposeId"]);
      if ("error" in purpose) return reply.code(400).send(purpose);
      change.purposeId = purpose.id;
      if (purpose.version !== undefined) change.purposeVersion = purpose.version;
    }
    if (change.name === undefined && change.purposeId === undefined) {
      return reply.code(400).send({ error: "give a name or a purpose" });
    }

    if (!agents.update(params.tenantId, agentId, change)) return reply.code(404).send({ error: "agent not found" });
    audit.record(params.tenantId, {
      actor: by(actor.user),
      action: "agent.updated",
      subject: agentId,
      detail: {
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.purposeId !== undefined ? { purposeId: change.purposeId } : {}),
      },
    });
    return { ok: true };
  });

  app.delete("/console/:tenantId/agents/:agentId", async (request: ConsoleRequest, reply) => {
    const params = request.params as { tenantId: string; agentId: string };
    const actor = requireRole(request, reply, params.tenantId, "owner");
    if (!actor) return;
    const agentId = readAgentId(params.agentId);
    if (agentId === undefined) return reply.code(400).send({ error: "not an agent id" });

    if (!agents.remove(params.tenantId, agentId)) return reply.code(404).send({ error: "agent not found" });
    audit.record(params.tenantId, { actor: by(actor.user), action: "agent.removed", subject: agentId, detail: {} });
    return { ok: true };
  });

  // ----------------------------------------------------------- sources

  app.put(
    "/console/:tenantId/sources/:provider/:kind/:sourceId/agent",
    async (request: ConsoleRequest, reply: FastifyReply) => {
      const params = request.params as { tenantId: string; provider: string; kind: string; sourceId: string };
      const actor = requireRole(request, reply, params.tenantId, "owner");
      if (!actor) return;
      const importer = importerFor(params.provider);
      if (!importer) return reply.code(400).send({ error: "unknown provider" });
      if (!isSourceKind(params.kind)) return reply.code(400).send({ error: "unknown source kind" });
      const id = readSourceId(params.kind, params.sourceId);
      if (id === undefined) return reply.code(400).send({ error: "not a valid source id for this kind" });
      const source: SourceKey = { provider: importer.provider, kind: params.kind, id };

      const body = bodyOf(request);
      const rawAgent = body["agentId"];
      const agentId = rawAgent === null ? null : readAgentId(rawAgent);
      if (agentId === undefined) return reply.code(400).send({ error: "agentId must be an agent id or null" });
      const sharedRaw = body["shared"] ?? false;
      if (typeof sharedRaw !== "boolean") return reply.code(400).send({ error: "shared must be true or false" });
      if (sharedRaw && agentId !== null) {
        return reply.code(400).send({ error: "a key used by several agents cannot also be put on one of them" });
      }

      const result = agents.assign(params.tenantId, source, { agentId, shared: sharedRaw, by: "owner" });
      if (result === "no-source") return reply.code(404).send({ error: "source not found" });
      if (result === "no-agent") return reply.code(404).send({ error: "agent not found" });
      audit.record(params.tenantId, {
        actor: by(actor.user),
        action: "source.assigned",
        subject: keyOf(source),
        detail: { agentId, shared: sharedRaw },
      });

      const twin = matchTwins(params.tenantId)[0];
      return { ok: true, matched: twin === undefined ? null : twin.source };
    },
  );
}
