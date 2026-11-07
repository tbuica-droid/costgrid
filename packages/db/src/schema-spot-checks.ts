import type { Migration } from "./schema.js";

/**
 * Migration 27: spot checks get their own switch.
 *
 * Graded answers are held in memory for the owner to read only while spot
 * checks are on (owner decision, 7 November 2026). Off by default.
 */
export const SPOT_CHECKS_MIGRATION: Migration = {
  version: 27,
  name: "spot-checks-switch",
  sql: `
    ALTER TABLE tenant_settings ADD COLUMN spot_checks INTEGER NOT NULL DEFAULT 0 CHECK (spot_checks IN (0, 1));
  `,
};
