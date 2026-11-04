import type { Migration } from "./schema.js";

/**
 * Migration 22: v3 quality foundations.
 *
 * What a person or the customer's software said about an answer (outcomes),
 * what CostGrid's own checks found (calls.answer_check), what a good answer
 * looks like for each agent (agents), and every routing choice with its
 * reason (routing_decisions). No answer text anywhere: a check result is one
 * word, a required field is a name.
 */
export const QUALITY_MIGRATION: Migration = {
  version: 22,
  name: "quality-foundations",
  sql: `
    -- A reported quality score from 0 to 1, in whole thousandths so it compares exactly.
    ALTER TABLE outcomes ADD COLUMN quality_milli INTEGER;
    -- What a person did with the answer: 'accepted', 'edited', 'rejected' or 'handed-off'.
    ALTER TABLE outcomes ADD COLUMN signal TEXT;

    -- 'pass', 'cut-off', 'refusal', 'not-json' or 'missing-field'; NULL when not judged.
    ALTER TABLE calls ADD COLUMN answer_check TEXT;

    -- 'any' or 'json'.
    ALTER TABLE agents ADD COLUMN answer_format TEXT NOT NULL DEFAULT 'any';
    -- A JSON list of top-level field names a good answer must have.
    ALTER TABLE agents ADD COLUMN required_fields TEXT;
    -- The score a reported answer needs to count as good, in thousandths. NULL means 500.
    ALTER TABLE agents ADD COLUMN quality_bar_milli INTEGER;

    CREATE TABLE routing_decisions (
      tenant_id              TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_id                TEXT NOT NULL,
      agent_id               TEXT NOT NULL,
      decided_at             INTEGER NOT NULL,
      -- 'route', 'fallback', 'adjust', 'kept' or 'not-routed'.
      kind                   TEXT NOT NULL,
      requested_model        TEXT NOT NULL,
      chosen_model           TEXT NOT NULL,
      -- 0 for a dry run: recorded, not made.
      applied                INTEGER NOT NULL CHECK (applied IN (0, 1)),
      policy_id              TEXT,
      reason                 TEXT NOT NULL,
      -- Nanodollars per call; NULL until predictions exist (phase 4).
      predicted_cost         INTEGER,
      predicted_quality_milli INTEGER,
      confidence_milli       INTEGER,
      -- A JSON list of { model, why } for the models considered and not chosen.
      rejected               TEXT,
      PRIMARY KEY (call_id, kind)
    ) STRICT;

    CREATE INDEX idx_routing_decisions_time ON routing_decisions(tenant_id, decided_at);
  `,
};
