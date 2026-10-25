import { formatPercent, formatUsdPerOutcome, toUsdString } from "@costgrid/core";
import {
  type AccountsRepository,
  type AgentOutcomes,
  type Db,
  type OutcomeSettingsRepository,
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
    costPerFinishedUsd: r?.lcso.lcso1.reported ? formatUsdPerOutcome(r.lcso.lcso1.value, 6) : null,
    failureCostShare: r?.failureCostShare.reported ? formatPercent(r.failureCostShare.value, 1) : null,
    totalCostUsd: toUsdString(a.totalCost, 6),
    mostlyInferred: r?.flags.includes("mostly-tier-c") ?? false,
    escalationTools: a.escalationTools,
    sharedOpenings: a.sharedOpenings,
    identity,
  };
}

export function registerOutcomes(app: FastifyInstance, deps: OutcomeDeps): void {
  const { accounts, settings } = deps;
  const { requireRole } = createGuards(accounts);
  const outcomes = new RunOutcomes(deps.db);
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
      noOutcomeData: report.noOutcomeData,
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
}
