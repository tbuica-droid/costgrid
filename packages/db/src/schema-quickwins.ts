import type { Migration } from "./schema.js";

/**
 * Migration 21: v3 quick wins.
 *
 * `call_adjustments` records each change an adjustment rule made to a call
 * (lower reasoning, cache breakpoints), or would have made in a dry run. It is
 * its own table because most calls have none and a call can have two, and
 * because the before-and-after measurement reads it by rule.
 *
 * `deferred_batches` tracks work sent to a provider's batch API. It holds the
 * provider's ids and the counts, never a request or an answer.
 */
export const QUICK_WINS_MIGRATION: Migration = {
  version: 21,
  name: "quick-wins",
  sql: `
    CREATE TABLE call_adjustments (
      tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_id      TEXT NOT NULL,
      policy_id    TEXT NOT NULL,
      -- 'lower-reasoning' or 'add-cache'.
      kind         TEXT NOT NULL,
      -- What changed: 'effort:high->low', 'cache:tools,system'.
      change       TEXT NOT NULL,
      -- 0 for a dry run: recorded, not made.
      applied      INTEGER NOT NULL CHECK (applied IN (0, 1)),
      occurred_at  INTEGER NOT NULL,
      PRIMARY KEY (call_id, policy_id)
    ) STRICT;

    CREATE INDEX idx_call_adjustments_policy ON call_adjustments(tenant_id, policy_id, occurred_at);

    CREATE TABLE deferred_batches (
      id                 TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_id           TEXT NOT NULL,
      department         TEXT NOT NULL,
      provider           TEXT NOT NULL,
      provider_batch_id  TEXT NOT NULL,
      -- 'in_progress', 'ended', 'failed', 'expired' or 'canceled'.
      status             TEXT NOT NULL,
      request_count      INTEGER NOT NULL,
      succeeded_count    INTEGER NOT NULL DEFAULT 0,
      errored_count      INTEGER NOT NULL DEFAULT 0,
      -- Where the provider keeps the results: a URL or a file id. Never the results.
      results_ref        TEXT,
      errors_ref         TEXT,
      error_message      TEXT,
      created_at         INTEGER NOT NULL,
      checked_at         INTEGER,
      ended_at           INTEGER,
      -- Set once every result line has been priced and recorded as a call.
      metered_at         INTEGER,
      -- Nanodollars, at the batch rate, once metered.
      cost_total         INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE INDEX idx_deferred_tenant ON deferred_batches(tenant_id, created_at);
    CREATE INDEX idx_deferred_unmetered ON deferred_batches(metered_at) WHERE metered_at IS NULL;
  `,
};
