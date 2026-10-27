import type { Migration } from "./schema.js";

/**
 * Migration 20: spend running totals.
 *
 * Before each proxied call, every budget rule asks what has been spent today
 * and this month. Answered from `calls`, that is a sum over every call in the
 * month, so the check slows as traffic grows, on the one path where CostGrid
 * adds latency. These totals answer it from at most 31 rows per agent.
 *
 * One row per tenant, UTC day, agent and team, holding the cost of calls that
 * went through ('ok'), exactly what the old sum counted. `recordCall` adds to
 * it in the same transaction as the call, so the two cannot disagree.
 */
export const SPEND_MIGRATION: Migration = {
  version: 20,
  name: "spend-running-totals",
  sql: `
    CREATE TABLE spend_daily (
      tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      -- Midnight UTC of the call's day, in epoch milliseconds.
      day_start   INTEGER NOT NULL,
      agent_id    TEXT NOT NULL,
      department  TEXT NOT NULL,
      -- Nanodollars.
      cost_total  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, day_start, agent_id, department)
    ) STRICT;

    CREATE INDEX idx_spend_daily_agent ON spend_daily(tenant_id, agent_id, day_start);
    CREATE INDEX idx_spend_daily_department ON spend_daily(tenant_id, department, day_start);

    -- Every call already recorded, so budgets read the same figure the moment
    -- this runs as they did before it.
    INSERT INTO spend_daily (tenant_id, day_start, agent_id, department, cost_total)
    SELECT tenant_id, (started_at / 86400000) * 86400000, agent_id, department, SUM(cost_total)
    FROM calls
    WHERE outcome = 'ok'
    GROUP BY tenant_id, (started_at / 86400000) * 86400000, agent_id, department;
  `,
};
