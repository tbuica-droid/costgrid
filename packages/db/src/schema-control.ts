import type { Migration } from "./schema.js";

/**
 * Migration 19: View and control.
 *
 * Which tier an organisation is on, the monthly cap an owner set on each
 * agent, and every pause or resume CostGrid asked a provider for, with the
 * times that make up its measured stop time.
 */
export const CONTROL_MIGRATION: Migration = {
  version: 19,
  name: "view-and-control",
  sql: `
    -- No row means View, the free tier.
    CREATE TABLE tenant_tier (
      tenant_id   TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      tier        TEXT NOT NULL CHECK (tier IN ('view', 'control')),
      updated_at  INTEGER NOT NULL
    ) STRICT;

    -- A CostGrid cap: when the provider's usage report shows the agent has
    -- spent this much in a calendar month (UTC), its keys are paused.
    CREATE TABLE agent_caps (
      tenant_id    TEXT NOT NULL,
      agent_id     TEXT NOT NULL,
      -- Nanodollars a month.
      monthly_cap  INTEGER NOT NULL CHECK (monthly_cap > 0),
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, agent_id),
      FOREIGN KEY (tenant_id, agent_id) REFERENCES agents(tenant_id, id) ON DELETE CASCADE
    ) STRICT;

    -- Every pause or resume asked of a provider, kept after the agent goes:
    -- it is the record of what CostGrid did to someone's keys.
    CREATE TABLE key_actions (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_id       TEXT NOT NULL,
      provider       TEXT NOT NULL,
      key_id         TEXT NOT NULL,
      action         TEXT NOT NULL CHECK (action IN ('pause', 'resume')),
      reason         TEXT NOT NULL CHECK (reason IN ('owner', 'cap')),
      requested_at   INTEGER NOT NULL,
      finished_at    INTEGER,
      ok             INTEGER CHECK (ok IN (0, 1)),
      error          TEXT,
      -- For a cap pause: the end of the newest usage the decision saw, and
      -- the month the cap was for. Stop time is measured from these.
      usage_through  INTEGER,
      cap_month      TEXT
    ) STRICT;
    CREATE INDEX idx_key_actions_agent ON key_actions(tenant_id, agent_id, requested_at);
  `,
};
