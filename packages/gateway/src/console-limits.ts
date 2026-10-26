import {
  EFFORT_LEVELS,
  type EnforcementAction,
  findModelPrice,
  isReasoningEffort,
  listModelPrices,
  type Nanodollars,
  type PolicyRule,
  type PolicyScope,
  toUsdString,
  usd,
} from "@costgrid/core";
import {
  type AccountsRepository,
  type AlertsRepository,
  type CostGridRepository,
  type Db,
  MeasuredSavings,
  type MeasuredSwitch,
  RuleRegister,
  trailingWindow,
} from "@costgrid/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Alerter } from "./alerts.js";
import { type ConsoleRequest, createGuards } from "./console.js";

/**
 * The Limits screen: setting, stopping and accounting for every rule.
 *
 * Until this existed, a limit could be measured in the app but only enforced
 * from the command line, which meant a business trialling CostGrid needed
 * someone at a terminal to make it do the one thing it is for. Everything
 * here is the same rule engine the command line drives; the screen adds no
 * capability the engine does not have.
 *
 * Three disciplines carried over from the research:
 *
 *   - Every rule can carry an owner and a reason (rule debt, arXiv:2605.23179;
 *     NIST AI RMF GOVERN 2.1 on documented roles).
 *   - Stopping is one click, and resuming keeps the record (EY's agentic
 *     circuit breakers; NIST AI RMF MANAGE 2.4).
 *   - A switch to a cheaper model is judged on measured before-and-after cost,
 *     not on the estimate (arXiv:2603.23971).
 */

export interface LimitsDeps {
  readonly db: Db;
  readonly accounts: AccountsRepository;
  readonly repository: CostGridRepository;
  readonly alerts: AlertsRepository;
  readonly alerter: Alerter | undefined;
}

const money = (value: Nanodollars): string => toUsdString(value, 6);

/** Rules hold money as bigint, which JSON cannot carry. */
export function ruleView(rule: PolicyRule): Record<string, unknown> {
  if (rule.kind === "budget" || rule.kind === "run-budget") {
    const { limit, ...rest } = rule;
    return { ...rest, limitUsd: money(limit) };
  }
  return { ...rule };
}

function measuredView(m: MeasuredSwitch): Record<string, unknown> {
  const cohort = (c: MeasuredSwitch["before"]) => ({
    calls: c.calls,
    costPerCallUsd: c.costPerCall === null ? null : money(c.costPerCall),
    outputTokensPerCall: c.outputTokensPerCall,
    reasoningTokensPerCall: c.reasoningTokensPerCall,
    runs: c.runs,
    costPerRunUsd: c.costPerRun === null ? null : money(c.costPerRun),
  });
  return {
    policyId: m.policyId,
    policyName: m.policyName,
    fromModel: m.fromModel,
    toModel: m.toModel,
    liveSince: m.liveSince,
    before: cohort(m.before),
    after: cohort(m.after),
    estimatedSavingPerCallUsd: m.estimatedSavingPerCall === null ? null : money(m.estimatedSavingPerCall),
    measuredSavingPerCallUsd: m.measuredSavingPerCall === null ? null : money(m.measuredSavingPerCall),
    changePerCall: m.changePerCall,
    changePerRun: m.changePerRun,
    verdict: m.verdict,
    caveat: m.caveat,
  };
}

function parseScope(raw: unknown): PolicyScope | string {
  const scope = raw as Record<string, unknown> | undefined;
  const value = (key: string): string =>
    typeof scope?.[key] === "string" ? (scope[key] as string).trim().slice(0, 128) : "";
  if (scope?.["kind"] === "tenant") return { kind: "tenant" };
  if (scope?.["kind"] === "agent" && value("agentId") !== "") return { kind: "agent", agentId: value("agentId") };
  if (scope?.["kind"] === "department" && value("department") !== "") {
    return { kind: "department", department: value("department") };
  }
  return "choose who this applies to: everything, a team, or one agent";
}

function positiveUsd(raw: unknown): Nanodollars | string {
  // Nine whole digits is a billion dollars, and keeps the nanodollar figure inside SQLite's integer.
  if (typeof raw !== "string" || !/^\d{1,9}(\.\d{1,6})?$/.test(raw.trim())) {
    return "the amount must be a number of dollars, like 250 or 12.50";
  }
  const amount = usd(raw.trim());
  return amount > 0n ? amount : "the amount must be more than zero";
}

function fallbackOf(raw: unknown): string | undefined | { error: string } {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !findModelPrice(raw)) {
    return { error: "the cheaper model must be one CostGrid can price" };
  }
  return raw;
}

/** Validate a rule from the screen. This is a write boundary. */
export function parseLimit(body: Record<string, unknown>): PolicyRule | string {
  const kind = body["kind"];
  if (kind === "budget" || kind === "run-budget") {
    const limit = positiveUsd(body["limitUsd"]);
    if (typeof limit === "string") return limit;
    const fallback = fallbackOf(body["fallbackModel"]);
    if (typeof fallback === "object") return fallback.error;
    if (kind === "run-budget") {
      return { kind, limit, ...(fallback !== undefined ? { fallbackModel: fallback } : {}) };
    }
    const window = body["window"];
    if (window !== "day" && window !== "month") return "the window must be a day or a month";
    return { kind, window, limit, ...(fallback !== undefined ? { fallbackModel: fallback } : {}) };
  }
  if (kind === "run-steps") {
    const limit = body["limit"];
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100_000) {
      return "the step limit must be a whole number of calls";
    }
    return { kind, limit };
  }
  if (kind === "max-reasoning") {
    const effort = body["effort"];
    const budget = body["budgetTokens"];
    const rule: { kind: "max-reasoning"; effort?: (typeof EFFORT_LEVELS)[number]; budgetTokens?: number } = {
      kind,
    };
    if (effort !== undefined && effort !== "") {
      if (!isReasoningEffort(effort)) return `effort must be one of ${EFFORT_LEVELS.join(", ")}`;
      rule.effort = effort;
    }
    if (budget !== undefined && budget !== "") {
      if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 1 || budget > 10_000_000) {
        return "the thinking budget must be a whole number of tokens";
      }
      rule.budgetTokens = budget;
    }
    if (rule.effort === undefined && rule.budgetTokens === undefined) {
      return "set an effort level, a thinking budget, or both";
    }
    return rule;
  }
  return "that kind of limit cannot be set from here";
}

/**
 * A delivery error with any address taken out. The webhook address is a
 * credential (whoever has it can post to the channel), and a fetch error can
 * quote it ("Failed to parse URL from https://hooks…").
 */
export function withoutAddress(message: string): string {
  return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address]").slice(0, 300);
}

function text(raw: unknown, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, max);
}

function describeScope(scope: PolicyScope): string {
  return scope.kind === "tenant"
    ? "everything"
    : scope.kind === "department"
      ? `the ${scope.department} team`
      : scope.agentId;
}

export function registerLimits(app: FastifyInstance, deps: LimitsDeps): void {
  const { accounts, alerts, alerter, db, repository } = deps;
  const { audit } = accounts;
  const { requireRole } = createGuards(accounts);
  const register = new RuleRegister(db, repository);
  const measured = new MeasuredSavings(db);
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

  app.get("/console/:tenantId/limits", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;

    const entries = register.entries(tenantId, trailingWindow(30));
    const agents = db
      .prepare(
        `SELECT id, department, last_seen_at AS lastSeenAt
         FROM agents WHERE tenant_id = ? AND last_seen_at IS NOT NULL
         ORDER BY last_seen_at DESC LIMIT 500`,
      )
      // Limits act on proxied traffic, so an agent named in setup that has
      // never sent any is not offered here.
      .all(tenantId) as { id: string; department: string; lastSeenAt: number }[];

    return {
      rules: entries.map((e) => ({ ...e, rule: ruleView(e.rule) })),
      agents,
      alertSettings: alerts.settings(tenantId),
      alerts: alerts.recent(tenantId, 30).map((a) => ({
        id: a.id,
        kind: a.kind,
        subject: a.subject,
        message: a.message,
        occurredAt: a.occurredAt,
        deliveredAt: a.deliveredAt,
        attempts: a.attempts,
        lastError: a.lastError === null ? null : withoutAddress(a.lastError),
      })),
      measured: measured.forPolicies(tenantId, entries).map(measuredView),
      models: listModelPrices()
        .filter((m) => !m.retired)
        .map((m) => ({ id: m.id, provider: m.provider, tier: m.tier })),
      efforts: EFFORT_LEVELS,
    };
  });

  /**
   * Set a limit.
   *
   * The action defaults to measuring. A limit that refuses calls the moment
   * it is typed in, before anyone has seen what it would have refused, is how
   * a cost control becomes an outage; the screen offers the stronger actions
   * explicitly.
   */
  app.post("/console/:tenantId/limits", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const scope = parseScope(body["scope"]);
    if (typeof scope === "string") return bad(reply, scope);
    const rule = parseLimit(body);
    if (typeof rule === "string") return bad(reply, rule);
    const action = (body["action"] ?? "monitor") as EnforcementAction;
    if (action !== "monitor" && action !== "warn" && action !== "block") {
      return bad(reply, "action must be monitor, warn or block");
    }
    const owner = text(body["owner"], 120);
    const reason = text(body["reason"], 300);
    const name = text(body["name"], 80) ?? `${rule.kind} for ${describeScope(scope)}`;

    const id = repository.createPolicy(tenantId, {
      name,
      scope,
      rule,
      action,
      enabled: true,
      ...(owner !== undefined ? { owner } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "policy.created",
      subject: id,
      detail: { name, kind: rule.kind, action, source: "console", owner: owner ?? null },
    });
    return reply.code(201).send({ id });
  });

  /** Switch a rule on or off, or record its owner and reason. */
  app.patch("/console/:tenantId/limits/:policyId", async (request: ConsoleRequest, reply) => {
    const { tenantId, policyId } = request.params as { tenantId: string; policyId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const policy = repository.listPolicies(tenantId).find((p) => p.id === policyId);
    if (policy === undefined) return reply.code(404).send({ error: "rule not found" });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const by = { kind: "user" as const, id: actor.user.id, label: actor.user.email };
    if (typeof body["enabled"] === "boolean" && body["enabled"] !== policy.enabled) {
      repository.setPolicyEnabled(policyId, body["enabled"]);
      audit.record(tenantId, {
        actor: by,
        action: body["enabled"] ? "policy.enabled" : "policy.disabled",
        subject: policyId,
        detail: { name: policy.name, kind: policy.rule.kind },
      });
    }
    const owner = text(body["owner"], 120);
    const reason = text(body["reason"], 300);
    if (owner !== undefined || reason !== undefined) {
      register.annotate(tenantId, policyId, {
        ...(owner !== undefined ? { owner } : {}),
        ...(reason !== undefined ? { reason } : {}),
      });
      audit.record(tenantId, {
        actor: by,
        action: "policy.annotated",
        subject: policyId,
        detail: { owner: owner ?? null, reasonChanged: reason !== undefined },
      });
    }
    return { id: policyId };
  });

  /**
   * Stop an agent, a team or everything, from the next call.
   *
   * Written as a `stop` rule that blocks, so it shows in the register, the
   * enforcement feed and the audit log like any other decision. Stopping the
   * same scope twice is refused rather than stacked, so one resume is always
   * enough.
   */
  app.post("/console/:tenantId/stop", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const scope = parseScope(body["scope"]);
    if (typeof scope === "string") return bad(reply, scope);
    const reason = text(body["reason"], 300);

    const already = repository
      .listPolicies(tenantId)
      .find((p) => p.enabled && p.rule.kind === "stop" && JSON.stringify(p.scope) === JSON.stringify(scope));
    if (already !== undefined) return reply.code(409).send({ error: "that is already stopped", id: already.id });

    const name = `Stop ${describeScope(scope)}`;
    const id = repository.createPolicy(tenantId, {
      name,
      scope,
      rule: { kind: "stop" },
      action: "block",
      enabled: true,
      owner: actor.user.email,
      ...(reason !== undefined ? { reason } : {}),
    });
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "policy.created",
      subject: id,
      detail: { name, kind: "stop", action: "block", source: "console" },
    });
    alerter?.raise(tenantId, {
      kind: "stopped",
      dedupeKey: `stop:${id}`,
      subject: describeScope(scope),
      message:
        `${actor.user.email} stopped ${describeScope(scope)}` +
        (reason !== undefined ? ` (${reason})` : "") +
        ". Every call from it is refused before it reaches the provider until it is resumed.",
    });
    return reply.code(201).send({ id });
  });

  /** Resume: switch the stop rule off, keeping the record that it happened. */
  app.post("/console/:tenantId/resume/:policyId", async (request: ConsoleRequest, reply) => {
    const { tenantId, policyId } = request.params as { tenantId: string; policyId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const policy = repository.listPolicies(tenantId).find((p) => p.id === policyId);
    if (policy === undefined || policy.rule.kind !== "stop") {
      return reply.code(404).send({ error: "no such stop" });
    }
    repository.setPolicyEnabled(policyId, false);
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "policy.disabled",
      subject: policyId,
      detail: { name: policy.name, kind: "stop" },
    });
    return { id: policyId, resumed: true };
  });

  /** Where alerts go. The address is never sent back, only a masked hint. */
  app.put("/console/:tenantId/alerts", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const change: { webhookUrl?: string | null; desktop?: boolean } = {};
    if (body["webhookUrl"] === null || body["webhookUrl"] === "") change.webhookUrl = null;
    else if (typeof body["webhookUrl"] === "string") change.webhookUrl = body["webhookUrl"];
    if (typeof body["desktop"] === "boolean") change.desktop = body["desktop"];

    let settings;
    try {
      settings = alerts.configure(tenantId, change);
    } catch (error) {
      return bad(reply, error instanceof Error ? error.message : "invalid alert settings");
    }
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "alerts.configured",
      subject: tenantId,
      // Whether an address is set, never the address: it is a credential.
      detail: { webhook: settings.webhookConfigured, desktop: settings.desktop },
    });
    return settings;
  });

  /** Send one alert now, so the person setting this up sees it arrive. */
  app.post("/console/:tenantId/alerts/test", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    if (alerter === undefined) return reply.code(409).send({ error: "alerts are not available here" });

    const stored = alerts.raise(tenantId, {
      kind: "test",
      dedupeKey: `test:${Date.now()}:${Math.random()}`,
      subject: actor.user.email,
      message: `Sent by ${actor.user.email} to check that alerts reach you. No limit fired.`,
    });
    if (stored === undefined) return reply.code(409).send({ error: "try again" });
    const result = await alerter.deliver(stored);
    return {
      delivered: result.delivered,
      ...(result.error !== undefined ? { error: withoutAddress(result.error) } : {}),
      webhookConfigured: alerts.settings(tenantId).webhookConfigured,
    };
  });
}
