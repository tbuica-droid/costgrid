import type { Migration } from "./schema.js";

/**
 * Migration 17: what the owner types in so the results screen can say more
 * than the calls alone can.
 *
 * Both are estimates by the owner, and every screen that uses them says so.
 * Neither is ever mixed into a measured figure without being named.
 */
export const RESULTS_MIGRATION: Migration = {
  version: 17,
  name: "owner-results-inputs",
  sql: `
    -- How long one finished job takes a person, and what an hour of that
    -- person costs, fully loaded. Gives "compared with a person".
    CREATE TABLE agent_person_cost (
      tenant_id    TEXT NOT NULL,
      agent_id     TEXT NOT NULL,
      minutes      INTEGER NOT NULL CHECK (minutes BETWEEN 1 AND 10080),
      -- Nanodollars per hour.
      hourly_rate  INTEGER NOT NULL CHECK (hourly_rate > 0),
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, agent_id),
      FOREIGN KEY (tenant_id, agent_id) REFERENCES agents(tenant_id, id) ON DELETE CASCADE
    ) STRICT;

    -- For an agent known only from provider usage reports, which never say
    -- whether a job got done: how many jobs it finished in a month, by the
    -- owner's count. Gives the totals-only (aggregate) cost per finished job.
    CREATE TABLE agent_job_counts (
      tenant_id     TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      -- YYYY-MM, UTC.
      month         TEXT NOT NULL CHECK (length(month) = 7),
      finished      INTEGER NOT NULL CHECK (finished >= 0),
      -- NULL when the owner did not say; the success rate is then withheld.
      not_finished  INTEGER CHECK (not_finished >= 0),
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, agent_id, month),
      FOREIGN KEY (tenant_id, agent_id) REFERENCES agents(tenant_id, id) ON DELETE CASCADE
    ) STRICT;
  `,
};
