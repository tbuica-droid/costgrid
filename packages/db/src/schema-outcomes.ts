import type { Migration } from "./schema.js";

/**
 * Migration 16: what outcome detection needs from each proxied call.
 *
 * Whether a job got done is inferred from how runs of the same job behave,
 * so each call records which job it belongs to: the developer's
 * `x-costgrid-task`, or a one-way code of the job's first message (never the
 * message). On `calls` rather than a table of their own, so they are purged
 * with the calls they describe and no second retention path exists.
 */
export const OUTCOMES_MIGRATION: Migration = {
  version: 16,
  name: "outcome-detection",
  sql: `
    ALTER TABLE calls ADD COLUMN task_key TEXT;
    ALTER TABLE calls ADD COLUMN task_source TEXT CHECK (task_source IN ('header', 'fingerprint'));
    -- How many messages the request carried. A count, never content.
    ALTER TABLE calls ADD COLUMN turns INTEGER;
    CREATE INDEX idx_calls_task ON calls(tenant_id, agent_id, task_key, started_at);

    -- Whether this organisation matches repeat jobs by the opening's code.
    -- No row means on, the default the owner chose.
    CREATE TABLE outcome_settings (
      tenant_id    TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      fingerprint  INTEGER NOT NULL DEFAULT 1 CHECK (fingerprint IN (0, 1)),
      updated_at   INTEGER NOT NULL
    ) STRICT;
  `,
};
