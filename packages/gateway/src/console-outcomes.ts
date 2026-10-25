import {
  formatPercent,
  formatRatio,
  formatUsdPerOutcome,
  type LcsoResult,
  toUsdString,
  usd,
  verdictOf,
} from "@costgrid/core";
import {
  type AccountsRepository,
  type AgentOutcomes,
  type Db,
  isMonth,
  JobInputs,
  type OutcomeSettingsRepository,
  type PersonCost,
  personBaseline,
  type ProviderOnlyOutcomes,
  Retention,
  RunOutcomes,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";
import { bodyOf, by } from "./console-fields.js";

/**
 * Whether each agent's jobs got done, and the switch for matching repeat jobs.
 *
 * Every inferred figure here is labelled as such by the screen; the counts
 * that the owner's software reported (tier B) travel separately so they are
 * never presented as the same thing as an inference.
 */

export interface OutcomeDeps {
  readonly db: Db;
  readonly accounts: AccountsRepository;
  readonly settings: OutcomeSettingsRepository;
  /** Whether this install has a key to make one-way codes with. */
  readonly fingerprintAvailable: boolean;
}

const DAY_MS = 86_400_000;

const personView = (p: PersonCost) => ({
  minutes: p.minutes,
  hourlyUsd: toUsdString(p.hourlyRate, 2),
  costPerJobUsd: toUsdString(personBaseline(p).costPerOutcome, 2),
});

/**
 * The plain-language summary: the verdict, the headline cost per finished
 * job, and what is behind it. A figure the engine withheld is null, never 0.
 */
function summaryView(r: LcsoResult) {
  const spread = r.spread.reported ? r.spread.value : null;
  return {
    verdict: verdictOf(r),
    costPerFinishedUsd: r.lcso.lcso1.reported ? formatUsdPerOutcome(r.lcso.lcso1.value, 6) : null,
    failureCostShare: r.failureCostShare.reported ? formatPercent(r.failureCostShare.value, 1) : null,
    spread: spread && {
      typicalUsd: toUsdString(spread.p50, 6),
      badUsd: toUsdString(spread.p90, 6),
      ratio: spread.spreadRatio.reported ? formatRatio(spread.spreadRatio.value, 1) : null,
    },
    // AI cost per finished job over a person's: 0.25 means a quarter of the cost.
    personRatio: r.her.reported ? formatRatio(r.her.value.ratio, 2) : null,
    spendNoSuccesses: r.flags.includes("spend-but-no-successes"),
    successRate: r.rates.success.reported ? formatPercent(r.rates.success.value, 0) : null,
  };
}

function providerOnlyView(a: ProviderOnlyOutcomes) {
  return {
    id: a.id,
    name: a.name,
    person: a.person ? personView(a.person) : null,
    counts: a.counts.map((c) => ({ month: c.month, finished: c.finished, notFinished: c.notFinished })),
    latest: a.latest
      ? { month: a.latest.month, costUsd: toUsdString(a.latest.cost, 6), summary: summaryView(a.latest.result) }
      : null,
  };
}

function agentView(a: AgentOutcomes) {
  const r = a.result;
  const count = (state: string, tier?: string) =>
    a.tasks.filter((t) => t.task.state === state && (tier === undefined || t.task.evidenceTier === tier)).length;
  const signal = (s: string) => a.tasks.filter((t) => t.signals.includes(s as never)).length;
  const identity = { header: 0, fingerprint: 0, none: 0 };
  for (const t of a.tasks) identity[t.source] += 1;
  return {
    id: a.agentId,
    name: a.name,
    purposeId: a.purposeSet ? a.preset.id : null,
    purposeVersion: a.purposeSet ? a.preset.version : null,
    presetLabel: a.preset.label,
    evidence: a.preset.evidence,
    needsUpgrade: a.needsUpgrade,
    counts: {
      finished: r?.counts.success ?? 0,
      failed: r?.counts.failure ?? 0,
      abandoned: r?.counts.abandoned ?? 0,
      waiting: r?.counts.pending ?? 0,
      unknown: r?.counts.unknown ?? 0,
    },
    // Reported jobs are never still maturing: a report resolves them.
    reported: { finished: count("SUCCESS", "B"), failed: count("FAILURE", "B") },
    reasons: {
      handedOff: signal("handed-off"),
      askedAgain: signal("asked-again"),
      error: signal("error"),
      cutOff: signal("truncated"),
      declined: signal("refused"),
      blocked: signal("blocked"),
      reversed: r?.counts.clawedBack ?? 0,
    },
    totalCostUsd: toUsdString(a.totalCost, 6),
    mostlyInferred: r?.flags.includes("mostly-tier-c") ?? false,
    escalationTools: a.escalationTools,
    sharedOpenings: a.sharedOpenings,
    identity,
    person: a.person ? personView(a.person) : null,
    summary: r ? summaryView(r) : null,
  };
}

export function registerOutcomes(app: FastifyInstance, deps: OutcomeDeps): void {
  const { accounts, settings } = deps;
  const { requireRole } = createGuards(accounts);
  const outcomes = new RunOutcomes(deps.db);
  const inputs = new JobInputs(deps.db);
  const retention = new Retention(deps.db);
  const state = (tenantId: string) => ({
    available: deps.fingerprintAvailable,
    enabled: deps.fingerprintAvailable && settings.fingerprintEnabled(tenantId),
  });

  app.get("/console/:tenantId/outcomes", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;
    const raw = (request.query as Record<string, unknown> | undefined)?.["days"];
    const days = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return reply.code(400).send({ error: "days must be an integer between 1 and 365" });
    }

    const now = Date.now();
    const report = outcomes.forTenant(tenantId, { from: now - days * DAY_MS, to: now + 1 }, now);
    const callDays = retention.settingsOf(tenantId).callDays;
    return {
      range: { from: new Date(now - days * DAY_MS).toISOString().slice(0, 10), to: new Date(now).toISOString().slice(0, 10) },
      fingerprint: state(tenantId),
      agents: report.agents.map(agentView),
      noOutcomeData: report.noOutcomeData.map(providerOnlyView),
      retentionNote: callDays > 0 && callDays * DAY_MS < report.longestWindowMs,
    };
  });

  app.get("/console/:tenantId/outcome-settings", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;
    return state(tenantId);
  });

  app.put("/console/:tenantId/outcome-settings", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const enabled = bodyOf(request)["enabled"];
    if (typeof enabled !== "boolean") return reply.code(400).send({ error: "enabled must be true or false" });

    const forgotten = settings.setFingerprint(tenantId, enabled);
    accounts.audit.record(tenantId, {
      actor: by(actor.user),
      action: "outcomes.matching",
      subject: tenantId,
      detail: { enabled, codesDeleted: forgotten },
    });
    return state(tenantId);
  });

  // What a finished job costs done by a person: the owner's estimate, labelled as one wherever it shows.
  app.put("/console/:tenantId/agents/:agentId/person-cost", async (request: ConsoleRequest, reply) => {
    const { tenantId, agentId } = request.params as { tenantId: string; agentId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    const body = bodyOf(request);
    let cost: { minutes: number; hourlyRate: bigint } | null = null;
    if (body["clear"] !== true) {
      const minutes = body["minutes"];
      const hourly = body["hourlyUsd"];
      if (typeof minutes !== "number" || !Number.isInteger(minutes)) {
        return reply.code(400).send({ error: "minutes must be a whole number" });
      }
      if (typeof hourly !== "string" || !/^\d{1,5}(\.\d{1,2})?$/.test(hourly.trim())) {
        return reply.code(400).send({ error: "the hourly cost must be a number of dollars, like 35 or 42.50" });
      }
      cost = { minutes, hourlyRate: usd(hourly.trim()) };
    }
    let found: boolean;
    try {
      found = inputs.setPersonCost(tenantId, agentId, cost);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid person cost" });
    }
    if (!found) return reply.code(404).send({ error: "no such agent" });
    accounts.audit.record(tenantId, {
      actor: by(actor.user),
      action: "agent.person-cost",
      subject: agentId,
      detail: cost ? { minutes: cost.minutes, hourlyUsd: toUsdString(cost.hourlyRate, 2) } : { cleared: true },
    });
    return { ok: true };
  });

  // How many jobs an agent known only from provider reports finished in a month, by the owner's count.
  app.put("/console/:tenantId/agents/:agentId/job-counts/:month", async (request: ConsoleRequest, reply) => {
    const { tenantId, agentId, month } = request.params as { tenantId: string; agentId: string; month: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    if (!isMonth(month)) return reply.code(400).send({ error: "month must be YYYY-MM" });
    if (month > new Date().toISOString().slice(0, 7)) {
      return reply.code(400).send({ error: "jobs can only be counted for this month or earlier" });
    }
    const body = bodyOf(request);
    const whole = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    let count: { finished: number; notFinished: number | null } | null = null;
    if (body["clear"] !== true) {
      const notFinished = body["notFinished"] ?? null;
      if (!whole(body["finished"]) || (notFinished !== null && !whole(notFinished))) {
        return reply.code(400).send({ error: "job counts must be whole numbers of zero or more" });
      }
      count = { finished: body["finished"] as number, notFinished: notFinished as number | null };
    }
    let found: boolean;
    try {
      found = inputs.setJobCount(tenantId, agentId, month, count);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid job count" });
    }
    if (!found) return reply.code(404).send({ error: "no such agent" });
    accounts.audit.record(tenantId, {
      actor: by(actor.user),
      action: "agent.job-count",
      subject: agentId,
      detail: count ? { month, ...count } : { month, cleared: true },
    });
    return { ok: true };
  });
}
