/**
 * The CostGrid schema.
 *
 * Written for SQLite because that is what a self-hosted single-tenant deploy
 * and a laptop both run with no daemon. Every construct here is deliberately
 * portable to Postgres: no SQLite-only types, integer timestamps, TEXT ids,
 * and money as INTEGER nanodollars. The repository layer is the only code that
 * speaks SQL, so swapping the driver is a contained change.
 *
 * Multi-tenancy is present from the first migration even though the first
 * deployment is single-tenant. Retrofitting a tenant column onto a metering
 * table that already has production rows is the kind of migration that causes
 * an outage, so the column exists from the start.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE tenants (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      ) STRICT;

      -- API keys are stored only as a SHA-256 hash. The plaintext key is shown
      -- once at creation and is not recoverable, so a database leak does not
      -- hand the attacker working credentials for the client's provider account.
      CREATE TABLE api_keys (
        id            TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        key_hash      TEXT NOT NULL UNIQUE,
        key_prefix    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        revoked_at    INTEGER
      ) STRICT;
      CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

      -- An agent is the unit a budget owner is accountable for. Agents are
      -- registered on first use so that metering never drops a call just
      -- because someone shipped a new service without telling finance.
      CREATE TABLE agents (
        id            TEXT NOT NULL,
        tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        department    TEXT NOT NULL DEFAULT 'Unassigned',
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, id)
      ) STRICT;

      -- The metering fact table: one row per upstream call attempt.
      --
      -- cost_* columns are INTEGER nanodollars (1 USD = 1e9). 'priced' is 0
      -- when the model was absent from the price catalog; those rows carry
      -- zero cost and must be reported as unpriced rather than as free.
      CREATE TABLE calls (
        id                    TEXT PRIMARY KEY,
        tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_id              TEXT NOT NULL,
        department            TEXT NOT NULL,
        provider              TEXT NOT NULL,
        model                 TEXT NOT NULL,
        started_at            INTEGER NOT NULL,
        duration_ms           INTEGER NOT NULL,
        streamed              INTEGER NOT NULL CHECK (streamed IN (0, 1)),

        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,

        cost_input            INTEGER NOT NULL DEFAULT 0,
        cost_output           INTEGER NOT NULL DEFAULT 0,
        cost_cache_write      INTEGER NOT NULL DEFAULT 0,
        cost_cache_read       INTEGER NOT NULL DEFAULT 0,
        cost_total            INTEGER NOT NULL DEFAULT 0,
        priced                INTEGER NOT NULL DEFAULT 1 CHECK (priced IN (0, 1)),

        -- 'ok' billed normally; 'blocked' never reached the provider and cost
        -- nothing; 'error' reached it and may or may not have billed.
        outcome               TEXT NOT NULL CHECK (outcome IN ('ok', 'blocked', 'error')),
        status_code           INTEGER,
        stop_reason           TEXT,
        error_message         TEXT
      ) STRICT;

      -- Spend queries are always scoped to a tenant and a time window; agent
      -- and model breakdowns ride on the same prefix.
      CREATE INDEX idx_calls_tenant_time ON calls(tenant_id, started_at);
      CREATE INDEX idx_calls_tenant_agent_time ON calls(tenant_id, agent_id, started_at);
      CREATE INDEX idx_calls_tenant_model_time ON calls(tenant_id, model, started_at);

      CREATE TABLE policies (
        id           TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('tenant', 'department', 'agent')),
        scope_value  TEXT,
        rule_json    TEXT NOT NULL,
        action       TEXT NOT NULL CHECK (action IN ('monitor', 'warn', 'block')),
        enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at   INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX idx_policies_tenant ON policies(tenant_id, enabled);

      -- The enforcement feed. A violation is recorded for every action,
      -- including 'monitor', which is what makes dry-run rollout possible.
      CREATE TABLE violations (
        id           TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        call_id      TEXT NOT NULL,
        policy_id    TEXT NOT NULL,
        policy_name  TEXT NOT NULL,
        action       TEXT NOT NULL CHECK (action IN ('monitor', 'warn', 'block')),
        reason       TEXT NOT NULL,
        occurred_at  INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX idx_violations_tenant_time ON violations(tenant_id, occurred_at);
    `,
  },
  {
    version: 2,
    name: "pricing-modifiers",
    // Without these a bill cannot be explained: two calls with identical token
    // counts on the same model legitimately cost different amounts when one ran
    // in fast mode (2x input/output), was pinned to US inference (1.1x on every
    // category), or went through the Batch API (0.5x). Recording what was in
    // effect makes each row's cost reproducible.
    sql: `
      ALTER TABLE calls ADD COLUMN speed TEXT;
      ALTER TABLE calls ADD COLUMN inference_geo TEXT;
      ALTER TABLE calls ADD COLUMN batch INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    name: "control-plane",
    // Everything a hosted deployment needs that a self-hosted one does not:
    // who the humans are, how they prove it, and whose provider credential
    // pays for a given call.
    sql: `
      -- A person. Email is the login identity and is stored lower-cased so
      -- "Tomas@x.com" and "tomas@x.com" cannot become two accounts.
      CREATE TABLE users (
        id             TEXT PRIMARY KEY,
        email          TEXT NOT NULL UNIQUE,
        name           TEXT NOT NULL,
        password_hash  TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_login_at  INTEGER
      ) STRICT;

      -- Membership joins people to tenants. A user can belong to several.
      -- 'owner' may manage billing, credentials and members; 'member' may not.
      CREATE TABLE memberships (
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (user_id, tenant_id)
      ) STRICT;
      CREATE INDEX idx_memberships_tenant ON memberships(tenant_id);

      -- Only the hash of a session token is stored, so a database leak does
      -- not hand an attacker live sessions.
      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        revoked_at  INTEGER
      ) STRICT;
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

      -- A tenant's own provider key, AES-256-GCM encrypted with a master key
      -- held outside the database.
      --
      -- This is what makes hosting possible at all: without it every tenant's
      -- traffic would bill to the operator's credential. 'secret_hint' is a
      -- masked tail for recognition only and is never sensitive.
      CREATE TABLE provider_credentials (
        tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider       TEXT NOT NULL,
        encrypted_key  TEXT NOT NULL,
        secret_hint    TEXT NOT NULL,
        base_url       TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, provider)
      ) STRICT;

      -- Subscription state. Kept on its own table rather than on tenants so a
      -- plan change is an insert-and-supersede, not a destructive update.
      CREATE TABLE subscriptions (
        tenant_id   TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        plan        TEXT NOT NULL,
        started_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: "historical-import",
    // Usage pulled from a provider's admin API, so a new customer sees their
    // own numbers before routing a single request through the gateway.
    //
    // Deliberately NOT written into `calls`. Provider reports are daily
    // aggregates; `calls` holds individual metered requests. Blending them
    // would fabricate call records and quietly destroy the one dataset we can
    // stand behind. Every read keeps the two apart and labels which is which.
    sql: `
      CREATE TABLE imported_usage (
        id                    TEXT PRIMARY KEY,
        tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider              TEXT NOT NULL,
        -- UTC day the provider bucketed this under, as YYYY-MM-DD.
        day                   TEXT NOT NULL,
        model                 TEXT NOT NULL,

        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        requests              INTEGER NOT NULL DEFAULT 0,

        -- What our catalog says these tokens cost at list price.
        cost_catalog          INTEGER NOT NULL DEFAULT 0,
        priced                INTEGER NOT NULL DEFAULT 1 CHECK (priced IN (0, 1)),
        -- What the provider says they actually charged, when it reported a
        -- figure. Differs from cost_catalog under a negotiated rate, which is
        -- how an effective discount becomes observable rather than guessed.
        cost_reported         INTEGER,

        imported_at           INTEGER NOT NULL,
        UNIQUE (tenant_id, provider, day, model)
      ) STRICT;
      CREATE INDEX idx_imported_tenant_day ON imported_usage(tenant_id, day);

      -- One row per import run, so a customer can see where their history
      -- came from and when, and a support question has an answer.
      CREATE TABLE import_runs (
        id            TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider      TEXT NOT NULL,
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER,
        from_day      TEXT NOT NULL,
        to_day        TEXT NOT NULL,
        rows_written  INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
        error_message TEXT
      ) STRICT;
      CREATE INDEX idx_import_runs_tenant ON import_runs(tenant_id, started_at);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
