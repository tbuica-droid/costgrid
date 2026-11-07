import type { Migration } from "./schema.js";

/**
 * Migration 24: what kind of task each call was (v3, phase 4).
 *
 * A label, never the words it came from. Calls made before this stay
 * unlabelled and are counted as such, never guessed after the fact.
 */
export const LABELS_MIGRATION: Migration = {
  version: 24,
  name: "task-labels",
  sql: `
    -- 'answer', 'chat', 'summarise', 'extract', 'classify', 'write', 'code', 'analyse' or 'agent-step'.
    ALTER TABLE calls ADD COLUMN task_kind TEXT;
    -- 's', 'm' or 'l', from the request's length.
    ALTER TABLE calls ADD COLUMN task_size TEXT;
    -- 'signals' or 'model'.
    ALTER TABLE calls ADD COLUMN labelled_by TEXT;
    CREATE INDEX idx_calls_agent_kind ON calls(tenant_id, agent_id, task_kind, started_at);
  `,
};
