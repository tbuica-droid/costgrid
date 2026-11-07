import type { Migration } from "./schema.js";

/**
 * Migration 26: per-request routing and self-checks (v3, phase 6).
 *
 * The routing table holds, per agent and kind of task, the model chosen on the
 * agent's own evidence, with the prediction behind the choice. Prediction
 * checks hold what was predicted each week and what then happened.
 */
export const ROUTING_MIGRATION: Migration = {
  version: 26,
  name: "per-request-routing",
  sql: `
    ALTER TABLE agents ADD COLUMN per_request INTEGER NOT NULL DEFAULT 0 CHECK (per_request IN (0, 1));
    -- The cheap model tried first, when cheap-first is on for the agent.
    ALTER TABLE agents ADD COLUMN step_up_model TEXT;

    CREATE TABLE routing_table (
      tenant_id                TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_id                 TEXT NOT NULL,
      task_kind                TEXT NOT NULL,
      model                    TEXT NOT NULL,
      -- Nanodollars per call.
      predicted_cost           INTEGER,
      predicted_quality_milli  INTEGER NOT NULL,
      confidence_milli         INTEGER NOT NULL,
      evidence_jobs            INTEGER NOT NULL,
      -- A JSON list of { model, why } for the models not chosen.
      rejected                 TEXT,
      built_at                 INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, agent_id, task_kind)
    ) STRICT;

    CREATE TABLE prediction_checks (
      tenant_id                TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_id                 TEXT NOT NULL,
      task_kind                TEXT NOT NULL,
      model                    TEXT NOT NULL,
      made_at                  INTEGER NOT NULL,
      predicted_quality_milli  INTEGER NOT NULL,
      low_milli                INTEGER NOT NULL,
      high_milli               INTEGER NOT NULL,
      predicted_cost           INTEGER,
      -- Filled in a week later.
      actual_quality_milli     INTEGER,
      actual_cost              INTEGER,
      judged                   INTEGER,
      within                   INTEGER CHECK (within IN (0, 1)),
      checked_at               INTEGER,
      PRIMARY KEY (tenant_id, agent_id, task_kind, model, made_at)
    ) STRICT;
  `,
};
