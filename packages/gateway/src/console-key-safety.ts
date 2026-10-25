import { keySafetyWarnings, toUsdString } from "@costgrid/core";
import { type AccountsRepository, type Db, KeyFactsRepository, SourcesRepository, toUtcDay } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";

/**
 * Warnings about risky key setups, for the Setup screen. Read-only: each
 * warning says what could go wrong and how to fix it at the provider;
 * CostGrid changes nothing here.
 */

export interface KeySafetyDeps {
  readonly db: Db;
  readonly accounts: AccountsRepository;
}

const DAY_MS = 86_400_000;
/** Spend in this window makes a key without an agent worth a warning. */
const RECENT_DAYS = 30;

export function registerKeySafety(app: FastifyInstance, deps: KeySafetyDeps): void {
  const { requireRole } = createGuards(deps.accounts);
  const keyFacts = new KeyFactsRepository(deps.db);
  const sources = new SourcesRepository(deps.db);

  app.get("/console/:tenantId/key-safety", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;
    const now = Date.now();
    const keys = keyFacts.list(tenantId);
    const adminKeys = sources.adminKeys(tenantId);
    const warnings = keySafetyWarnings({
      keys,
      sources: sources.list(tenantId, { from: toUtcDay(now - RECENT_DAYS * DAY_MS), to: toUtcDay(now) }).map((s) => ({
        provider: s.provider,
        kind: s.kind,
        id: s.id,
        label: s.label,
        agentId: s.agentId,
        shared: s.shared,
        lastDay: s.lastDay,
        recentCost: s.costNano,
      })),
      adminKeys,
      now,
    });
    return {
      // Key lists are read through a connected admin key; without one only the agent checks ran.
      keysChecked: adminKeys.length > 0 || keys.length > 0,
      recentDays: RECENT_DAYS,
      warnings: warnings.map((w) => ({
        code: w.code,
        severity: w.severity,
        provider: w.provider,
        subject: w.subject,
        days: w.days ?? null,
        recentCostUsd: w.recentCost === undefined ? null : toUsdString(w.recentCost, 2),
        neverUsed: w.neverUsed === true,
        atLeast: w.atLeast === true,
      })),
    };
  });
}
