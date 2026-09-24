import { type Nanodollars, type PolicyRule, toUsdString } from "@costgrid/core";
import {
  type AccountsRepository,
  Advisor,
  Autopilot,
  type AutopilotLevel,
  type BacktestResult,
  type CostGridRepository,
  type Db,
  Drift,
  type DriftSignal,
  type Proposal,
  trailingWindow,
} from "@costgrid/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";

/**
 * The console's reading of a fleet's own traffic: what changed, what CostGrid
 * would propose, and what autopilot may do about it.
 *
 * These were command-line only, and a desktop install has no command line
 * worth the name. The reports here are the same code the CLI runs; the two
 * writes (installing a proposed rule, changing autopilot) keep the CLI's
 * limits: a proposed rule is installed as a dry run and nothing else, and
 * autopilot's levels and caps are exactly the ones it enforces itself.
 *
 * Money crosses the wire as a decimal string, as everywhere else in the API.
 */

export interface AdviceDeps {
  readonly db: Db;
  readonly accounts: AccountsRepository;
  readonly repository: CostGridRepository;
}

function money(value: Nanodollars): string {
  return toUsdString(value, 6);
}

/** `?days=` with a default and a ceiling, rejected loudly rather than clamped. */
function days(request: FastifyRequest, fallback: number, max: number): number {
  const raw = (request.query as Record<string, unknown> | undefined)?.["days"];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw Object.assign(new Error(`days must be an integer between 1 and ${max}`), {
      statusCode: 400,
    });
  }
  return value;
}

/** Budget limits are bigint nanodollars, which JSON cannot carry. */
function ruleView(rule: PolicyRule): Record<string, unknown> {
  if (rule.kind === "budget" || rule.kind === "run-budget") {
    const { limit, ...rest } = rule;
    return { ...rest, limitUsd: money(limit) };
  }
  return { ...rule };
}

function backtestView(b: BacktestResult): Record<string, unknown> {
  return {
    callsInScope: b.callsInScope,
    spendInScopeUsd: money(b.spendInScope),
    callsAffected: b.callsAffected,
    amountUsd: b.amount === undefined ? null : money(b.amount),
    basis: b.basis,
    unpriceable: b.unpriceable,
    firstFireAt: b.firstFireAt ?? null,
    caveat: b.caveat,
  };
}

function proposalView(p: Proposal): Record<string, unknown> {
  return {
    kind: p.kind,
    intent: p.intent,
    headline: p.headline,
    evidence: p.evidence,
    scope: p.scope,
    rule: p.rule === undefined ? null : ruleView(p.rule),
    backtest: p.backtest === undefined ? null : backtestView(p.backtest),
    weightUsd: money(p.weight),
    command: p.command ?? null,
  };
}

function signalView(s: DriftSignal): Record<string, unknown> {
  const { spend, ...rest } = s;
  return { ...rest, subject: s.subject ?? null, spendUsd: money(spend) };
}

export function registerAdvice(app: FastifyInstance, deps: AdviceDeps): void {
  const { accounts, db, repository } = deps;
  const { audit } = accounts;
  const { requireRole } = createGuards(accounts);
  const advisor = new Advisor(db);
  const autopilot = new Autopilot(db);
  const drift = new Drift(db);

  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

  // ----------------------------------------------------------- what changed

  app.get("/console/:tenantId/drift", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;

    const window = days(request, 7, 365);
    const report = drift.report(tenantId, trailingWindow(window));
    return {
      days: window,
      baseline: report.baseline,
      recent: report.recent,
      baselineCalls: report.baselineCalls,
      established: report.established,
      signals: report.signals.map(signalView),
    };
  });

  /**
   * Stop offering an agent a tool it invented, as a dry run.
   *
   * The CLI prints the command for this next to the finding. Here the button
   * does the same thing with the same limits: the rule only records what it
   * would have stopped until somebody chooses to enforce it.
   */
  app.post("/console/:tenantId/drift/deny", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = request.body as Record<string, unknown> | undefined;
    const agentId = typeof body?.["agentId"] === "string" ? body["agentId"].trim() : "";
    const tool = typeof body?.["tool"] === "string" ? body["tool"].trim() : "";
    if (agentId === "" || tool === "") return bad(reply, "agentId and tool are required");

    const id = repository.createPolicy(tenantId, {
      name: `deny ${tool}`,
      scope: { kind: "agent", agentId },
      rule: { kind: "tool-denylist", tools: [tool] },
      action: "monitor",
      enabled: true,
    });
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "policy.created",
      subject: id,
      detail: { name: `deny ${tool}`, kind: "tool-denylist", action: "monitor", source: "drift" },
    });
    return reply.code(201).send({ id });
  });

  // ------------------------------------------------------------------ advice

  app.get("/console/:tenantId/advise", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;

    const window = days(request, 30, 3650);
    return {
      days: window,
      proposals: advisor.proposals(tenantId, trailingWindow(window)).map(proposalView),
    };
  });

  /**
   * Install one proposal, as a dry run.
   *
   * The rule is never taken from the request. The proposals are recomputed and
   * the one whose command matches is installed, so what gets written is what
   * the advisor produced, and a proposal the traffic no longer supports is
   * refused rather than installed on stale evidence.
   */
  app.post("/console/:tenantId/advise/apply", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = request.body as Record<string, unknown> | undefined;
    const command = typeof body?.["command"] === "string" ? body["command"] : "";
    if (command === "") return bad(reply, "command is required");
    const window = typeof body?.["days"] === "number" ? body["days"] : 30;
    if (!Number.isInteger(window) || window < 1 || window > 3650) {
      return bad(reply, "days must be an integer between 1 and 3650");
    }

    const proposal = advisor
      .proposals(tenantId, trailingWindow(window))
      .find((p) => p.command === command);
    if (proposal === undefined) {
      return reply.code(409).send({
        error: "that proposal is no longer on the list; the traffic has moved on. Reload and look again.",
      });
    }
    if (proposal.rule === undefined) {
      return bad(reply, "there is no rule to install; this one is a change in your own code");
    }

    const id = repository.createPolicy(tenantId, {
      name: proposal.headline,
      scope: proposal.scope,
      rule: proposal.rule,
      action: "monitor",
      enabled: true,
    });
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "policy.created",
      subject: id,
      detail: { name: proposal.headline, kind: proposal.rule.kind, action: "monitor", source: "advise" },
    });
    return reply.code(201).send({ id });
  });

  // --------------------------------------------------------------- autopilot

  app.get("/console/:tenantId/autopilot", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;
    return { settings: autopilot.settings(tenantId), actions: autopilot.actions(tenantId, 20) };
  });

  app.put("/console/:tenantId/autopilot", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const level = body["level"];
    if (level !== "off" && level !== "monitor" && level !== "apply") {
      return bad(reply, "level must be off, monitor or apply");
    }
    const cap = (field: string, max: number): number | undefined | null => {
      const value = body[field];
      if (value === undefined) return undefined;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
        return null;
      }
      return value;
    };
    const maxImpactPct = cap("maxImpactPct", 100);
    const maxActions = cap("maxActions", 50);
    if (maxImpactPct === null) return bad(reply, "maxImpactPct must be an integer between 1 and 100");
    if (maxActions === null) return bad(reply, "maxActions must be an integer between 1 and 50");

    const settings = autopilot.configure(tenantId, {
      level: level as AutopilotLevel,
      ...(maxImpactPct !== undefined ? { maxImpactPct } : {}),
      ...(maxActions !== undefined ? { maxActions } : {}),
    });
    // Granting or revoking the software's authority to change rules by itself
    // is precisely the kind of decision an audit log is for.
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "autopilot.level-changed",
      subject: settings.level,
      detail: {
        level: settings.level,
        maxImpactPct: settings.maxImpactPct,
        maxActions: settings.maxActions,
      },
    });
    return settings;
  });

  app.post("/console/:tenantId/autopilot/run", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const window = days(request, 30, 3650);
    const result = autopilot.run(tenantId, trailingWindow(window));
    if (result.level === "off") {
      return reply.code(409).send({ error: "autopilot is off. Switch it to monitor first." });
    }
    if (result.taken.length > 0) {
      audit.record(tenantId, {
        actor: { kind: "user", id: actor.user.id, label: actor.user.email },
        action: "autopilot.ran",
        subject: tenantId,
        detail: {
          level: result.level,
          days: window,
          considered: result.considered,
          taken: result.taken.length,
          declined: result.declined.length,
        },
      });
    }
    return { days: window, ...result };
  });

  app.post("/console/:tenantId/autopilot/undo", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const rulesDisabled = autopilot.undoAll(tenantId);
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "autopilot.undone",
      subject: tenantId,
      detail: { rulesDisabled },
    });
    return { rulesDisabled };
  });
}
