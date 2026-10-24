import type { Migration } from "./schema.js";

/**
 * Migration 15: agents the owner names, above the sources they use.
 *
 * Its own file because `schema.ts` is long enough already; `MIGRATIONS` lists
 * it in order like any other.
 *
 * Until now an agent was only a name the proxy saw in traffic, and an owner
 * named each provider key, workspace or project separately. One job done by
 * AI ("the support bot") often uses more than one of those, and one key can
 * be shared by several jobs, so the owner now names agents and says which
 * sources each one uses.
 */
export const AGENTS_MIGRATION: Migration = {
  version: 15,
  name: "agents-named-by-owner",
  sql: `
    -- One table for agents the proxy sees and agents the owner names, so an
    -- owner's agent id is also the x-costgrid-agent value that puts proxied
    -- traffic on it. Rebuilt because the seen-times become optional: an agent
    -- the owner names may never send traffic through CostGrid.
    CREATE TABLE agents_v15 (
      id               TEXT NOT NULL,
      tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      department       TEXT NOT NULL DEFAULT 'Unassigned',
      -- The owner's name for it, and which preset it is for at which version.
      name             TEXT,
      purpose_id       TEXT,
      purpose_version  TEXT,
      -- Who brought it into being: the proxy, on first sight, or the owner.
      origin           TEXT NOT NULL DEFAULT 'proxy' CHECK (origin IN ('proxy', 'owner')),
      created_at       INTEGER NOT NULL,
      -- NULL until a metered call carries this id.
      first_seen_at    INTEGER,
      last_seen_at     INTEGER,
      PRIMARY KEY (tenant_id, id)
    ) STRICT;

    INSERT INTO agents_v15 (id, tenant_id, department, origin, created_at, first_seen_at, last_seen_at)
    SELECT id, tenant_id, department, 'proxy', first_seen_at, first_seen_at, last_seen_at FROM agents;

    DROP TABLE agents;
    ALTER TABLE agents_v15 RENAME TO agents;

    -- Which agent a source is used by. Checked by the repository rather than
    -- a foreign key, which SQLite cannot add to an existing table.
    ALTER TABLE usage_sources ADD COLUMN agent_id TEXT;
    -- Used by several agents: never put on one of them, so its cost is never
    -- given to the wrong job. Always NULL agent_id when set.
    ALTER TABLE usage_sources ADD COLUMN shared INTEGER NOT NULL DEFAULT 0 CHECK (shared IN (0, 1));
    -- Whether the owner said so or a name match did. An owner's decision,
    -- including "not this agent", is never overridden by a match.
    ALTER TABLE usage_sources ADD COLUMN assigned_by TEXT CHECK (assigned_by IN ('owner', 'match'));
    ALTER TABLE usage_sources ADD COLUMN assigned_at INTEGER;
    -- The provider's name for the key's workspace or project, so a key seen
    -- in a usage file (by name) can be matched to the same key seen through
    -- the admin API (by id).
    ALTER TABLE usage_sources ADD COLUMN parent_label TEXT;
    CREATE INDEX idx_usage_sources_agent ON usage_sources(tenant_id, agent_id);

    -- Every source the owner named or gave a purpose becomes an agent of its
    -- own, so nothing said in setup is lost. display_name and purpose_id stay
    -- on usage_sources but are no longer written.
    CREATE TABLE agent_moves (
      tenant_id    TEXT NOT NULL,
      provider     TEXT NOT NULL,
      source_kind  TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      agent_id     TEXT NOT NULL,
      name         TEXT NOT NULL,
      purpose_id   TEXT,
      purpose_version TEXT,
      created_at   INTEGER NOT NULL
    );

    INSERT INTO agent_moves
    SELECT tenant_id, provider, source_kind, source_id,
           'agent-' || ROW_NUMBER() OVER (
             PARTITION BY tenant_id ORDER BY created_at, provider, source_kind, source_id),
           COALESCE(display_name, provider_label, NULLIF(source_id, ''), 'Whole account'),
           purpose_id, purpose_version, COALESCE(named_at, created_at)
    FROM usage_sources
    WHERE display_name IS NOT NULL OR purpose_id IS NOT NULL;

    -- An agent the proxy already knows by the same id is named, not duplicated.
    INSERT INTO agents (id, tenant_id, name, purpose_id, purpose_version, origin, created_at)
    SELECT agent_id, tenant_id, name, purpose_id, purpose_version, 'owner', created_at FROM agent_moves
    WHERE true
    ON CONFLICT (tenant_id, id) DO UPDATE SET
      name = excluded.name, purpose_id = excluded.purpose_id, purpose_version = excluded.purpose_version;

    UPDATE usage_sources SET
      agent_id = (SELECT m.agent_id FROM agent_moves m
                  WHERE m.tenant_id = usage_sources.tenant_id AND m.provider = usage_sources.provider
                    AND m.source_kind = usage_sources.source_kind AND m.source_id = usage_sources.source_id),
      assigned_by = 'owner',
      assigned_at = COALESCE(named_at, created_at)
    WHERE display_name IS NOT NULL OR purpose_id IS NOT NULL;

    DROP TABLE agent_moves;
  `,
};
