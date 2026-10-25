import type { Migration } from "./schema.js";

/**
 * Migration 18: what the provider's own key lists say about each API key,
 * for the key-safety warnings.
 *
 * Metadata only, from the same list calls that already fetch key names: no
 * key material, nothing the provider would not show an admin. Replaced in
 * full for a provider on every sync whose list call succeeded, so a deleted
 * key drops out.
 */
export const KEYS_MIGRATION: Migration = {
  version: 18,
  name: "provider-key-facts",
  sql: `
    CREATE TABLE provider_keys (
      tenant_id          TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider           TEXT NOT NULL,
      key_id             TEXT NOT NULL,
      label              TEXT,
      status             TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'archived', 'unknown')),
      key_created_at     INTEGER,
      -- Only OpenAI reports it.
      last_used_at       INTEGER,
      owner_kind         TEXT CHECK (owner_kind IN ('user', 'service-account')),
      -- Claude: 1 when the key is in the Default workspace.
      default_workspace  INTEGER CHECK (default_workspace IN (0, 1)),
      seen_at            INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, provider, key_id)
    ) STRICT;
  `,
};
