import type { Migration } from "./schema.js";

/**
 * Migration 25: trials and per-agent routing (v3, phase 5).
 *
 * A trial sends a share of one agent's jobs to a candidate model, alongside
 * the rest on its current one, and is judged on both arms at once. Grades
 * hold a grader's verdict and the owner's, never the answers. Settings mark
 * work that must never be tested and say whether an agent may switch on its
 * own.
 */
export const TRIALS_MIGRATION: Migration = {
  version: 25,
  name: "trials",
  sql: `
    CREATE TABLE trials (
      tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      id               TEXT NOT NULL,
      agent_id         TEXT NOT NULL,
      baseline_model   TEXT NOT NULL,
      candidate_model  TEXT NOT NULL,
      -- Thousandths of the agent's jobs sent to the candidate: 50 is 5%.
      share_milli      INTEGER NOT NULL,
      min_jobs         INTEGER NOT NULL,
      -- 'running', 'passed', 'failed', 'stopped', 'applied' or 'reverted'.
      status           TEXT NOT NULL,
      why              TEXT,
      -- The route rule a passed trial became, once applied.
      policy_id        TEXT,
      started_at       INTEGER NOT NULL,
      ended_at         INTEGER,
      PRIMARY KEY (tenant_id, id)
    ) STRICT;
    CREATE INDEX idx_trials_agent ON trials(tenant_id, agent_id, status);

    ALTER TABLE calls ADD COLUMN trial_id TEXT;
    -- 'candidate' or 'baseline'.
    ALTER TABLE calls ADD COLUMN trial_arm TEXT;
    -- 'work', or 'grading' for the extra calls side-by-side grading makes.
    ALTER TABLE calls ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work';
    CREATE INDEX idx_calls_trial ON calls(tenant_id, trial_id) WHERE trial_id IS NOT NULL;

    CREATE TABLE grades (
      tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      trial_id       TEXT NOT NULL,
      call_id        TEXT NOT NULL,
      run_id         TEXT NOT NULL,
      -- 'candidate', 'baseline' or 'tie'.
      verdict        TEXT NOT NULL,
      grader_model   TEXT NOT NULL,
      graded_at      INTEGER NOT NULL,
      -- The owner's verdict on the same pair, from a spot check.
      owner_verdict  TEXT,
      checked_at     INTEGER,
      PRIMARY KEY (tenant_id, call_id)
    ) STRICT;

    -- Work that must never be tested on.
    ALTER TABLE agents ADD COLUMN critical INTEGER NOT NULL DEFAULT 0 CHECK (critical IN (0, 1));
    -- 'suggest' (the owner approves each switch) or 'auto' (after an approved trial).
    ALTER TABLE agents ADD COLUMN switching TEXT NOT NULL DEFAULT 'suggest';

    CREATE TABLE tenant_settings (
      tenant_id            TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      grading              INTEGER NOT NULL DEFAULT 0 CHECK (grading IN (0, 1)),
      -- Thousandths of trial jobs sent for side-by-side grading: 15 is 1.5%.
      grading_share_milli  INTEGER NOT NULL DEFAULT 15,
      updated_at           INTEGER NOT NULL
    ) STRICT;
  `,
};
