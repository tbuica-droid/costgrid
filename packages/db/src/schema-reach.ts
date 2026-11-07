import type { Migration } from "./schema.js";

/**
 * Migration 23: v3 reach.
 *
 * Endpoints for open models (any service that accepts OpenAI-format
 * requests), the models each serves with the owner's prices and where they
 * came from, and which destinations each agent has opted in to beyond its
 * own provider.
 */
export const REACH_MIGRATION: Migration = {
  version: 23,
  name: "reach",
  sql: `
    CREATE TABLE model_endpoints (
      tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      id             TEXT NOT NULL,
      name           TEXT NOT NULL,
      -- Up to and including the API's version path: https://api.together.xyz/v1
      base_url       TEXT NOT NULL,
      -- Encrypted under the master key; NULL for a server that takes no key.
      encrypted_key  TEXT,
      key_hint       TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    ) STRICT;

    CREATE TABLE endpoint_models (
      tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      endpoint_id         TEXT NOT NULL,
      -- As the endpoint names it: meta-llama/Llama-3.3-70B-Instruct-Turbo
      model               TEXT NOT NULL,
      -- Nanodollars per million tokens. NULL: not priced, so calls are recorded unpriced.
      input_per_m         INTEGER,
      output_per_m        INTEGER,
      cached_input_per_m  INTEGER,
      -- Where the prices came from, and the day they were read there.
      price_source        TEXT,
      priced_on           TEXT,
      updated_at          INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, endpoint_id, model)
    ) STRICT;

    -- Destinations an agent may be sent to beyond its own provider:
    -- 'openai', 'anthropic', or 'open:<endpoint>'.
    CREATE TABLE agent_providers (
      tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      agent_id     TEXT NOT NULL,
      destination  TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, agent_id, destination)
    ) STRICT;
  `,
};
