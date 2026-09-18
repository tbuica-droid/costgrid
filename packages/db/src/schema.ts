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
  {
    version: 5,
    name: "auto-routing",
    // What the caller asked for, versus what was served, and the difference it
    // made. Without `requested_model` a rerouted call is indistinguishable
    // from one that simply used a cheap model, and the saving is unprovable.
    //
    // `saving_estimate` is the counterfactual: the same token counts priced at
    // the requested model, minus the actual cost. Signed, because a route can
    // make a call *more* expensive and that must be visible rather than
    // clamped away. Negative on a dry run too, where the "saving" is what
    // would have happened.
    sql: `
      ALTER TABLE calls ADD COLUMN requested_model TEXT;
      ALTER TABLE calls ADD COLUMN routed INTEGER NOT NULL DEFAULT 0 CHECK (routed IN (0, 1));
      ALTER TABLE calls ADD COLUMN route_dry_run INTEGER NOT NULL DEFAULT 0 CHECK (route_dry_run IN (0, 1));
      ALTER TABLE calls ADD COLUMN saving_estimate INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_calls_routed ON calls(tenant_id, routed, started_at);
    `,
  },
  {
    version: 6,
    name: "runs",
    // An agent run is many calls. Metering them individually answers "what did
    // this call cost" and cannot answer "what did this *run* cost", which is
    // the question a runaway loop poses at 3am.
    //
    // `run_id` is always set. When the caller propagates the header it is their
    // id and `run_declared` is 1; otherwise the call is its own run of one and
    // `run_declared` is 0. The distinction is load-bearing rather than
    // cosmetic: a run-scoped budget can never fire on synthetic runs, and a
    // customer whose rule silently does nothing deserves to know why.
    //
    // Historical rows are backfilled to their own id — each past call really
    // was a run of one, as far as anything here can know.
    //
    // `run_depth` is stored rather than walked. Depth is set once at insert
    // from the parent's depth, which is one indexed lookup; recomputing it by
    // recursing the parent chain on the metering path would put a recursive
    // CTE between the caller and their provider.
    sql: `
      ALTER TABLE calls ADD COLUMN run_id TEXT;
      ALTER TABLE calls ADD COLUMN parent_run_id TEXT;
      ALTER TABLE calls ADD COLUMN run_depth INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE calls ADD COLUMN run_declared INTEGER NOT NULL DEFAULT 0 CHECK (run_declared IN (0, 1));

      UPDATE calls SET run_id = id WHERE run_id IS NULL;

      CREATE INDEX idx_calls_run ON calls(tenant_id, run_id, started_at);
      CREATE INDEX idx_calls_parent_run ON calls(tenant_id, parent_run_id);
    `,
  },
  {
    version: 7,
    name: "tool-topology",
    // Which tools an agent can reach, and which it actually used.
    //
    // Names only. Tool *arguments* are content — a refund amount, a customer
    // id, a SQL fragment — and the promise is that content is forwarded and
    // never stored. A tool name is structural, like a table name, and it is
    // the whole of what a reachability policy needs.
    //
    // Two tables because the two facts have different shapes. An invocation is
    // sparse (most responses call nothing) and worth keeping per call, so a
    // run can be audited step by step. A grant repeats on every request that
    // declares the same toolset, so it is aggregated: the thousandth identical
    // declaration is not a thousandth fact.
    sql: `
      CREATE TABLE tool_invocations (
        id           TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        call_id      TEXT NOT NULL,
        run_id       TEXT NOT NULL,
        agent_id     TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        occurred_at  INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX idx_tool_inv_tenant ON tool_invocations(tenant_id, occurred_at);
      CREATE INDEX idx_tool_inv_run ON tool_invocations(tenant_id, run_id);
      CREATE INDEX idx_tool_inv_name ON tool_invocations(tenant_id, tool_name);

      CREATE TABLE tool_grants (
        tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_id     TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, agent_id, tool_name)
      ) STRICT;

      CREATE INDEX idx_tool_grants_tenant ON tool_grants(tenant_id, last_seen);
    `,
  },
  {
    version: 8,
    name: "negotiated-rates",
    // What the customer actually pays, alongside what the catalog says.
    //
    // An enterprise buys off list. Reporting list to someone on 18% off means
    // every figure disagrees with their invoice, which is fatal for a product
    // selling cost truth. `cost_total` therefore becomes what the call really
    // cost them, and `cost_list` preserves the catalog price so the discount
    // stays provable rather than asserted.
    //
    // Putting the effective figure in the existing column is deliberate: every
    // budget, statement and analytic already reads it, so none of them can be
    // left behind reporting list. A missed one would be worse than no feature
    // at all — numbers that reconcile in some places and not others.
    //
    // Historical rows are backfilled to equal cost_total, which is true: no
    // discount was applied to them.
    sql: `
      ALTER TABLE calls ADD COLUMN cost_list INTEGER NOT NULL DEFAULT 0;
      UPDATE calls SET cost_list = cost_total;

      -- Rates are rationals, never floats. A manual 18% off is 8200/10000; a
      -- derived one is the two observed totals themselves, so the override
      -- carries its own evidence.
      CREATE TABLE rate_overrides (
        tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider          TEXT NOT NULL,
        numerator         INTEGER NOT NULL,
        denominator       INTEGER NOT NULL CHECK (denominator > 0),
        source            TEXT NOT NULL CHECK (source IN ('manual', 'derived')),
        evidence_from     INTEGER,
        evidence_to       INTEGER,
        evidence_reported INTEGER,
        evidence_catalog  INTEGER,
        updated_at        INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, provider)
      ) STRICT;
    `,
  },
  {
    version: 9,
    name: "outcomes",
    // Did the run actually work?
    //
    // Every number in this product until now answers "what did it cost". None
    // of them answer "was it worth it", and a run that burned $4 and failed is
    // not cheaper than one that burned $6 and worked. Cost per *useful* result
    // is the figure a business owner actually wants, and it cannot be derived
    // from spend alone.
    //
    // There is no way to know this from the wire. CostGrid sees tokens, not
    // truth, so the signal has to be reported by the software that ran the
    // work. One optional call, and everything keeps working without it.
    //
    // `source` is the whole discipline here. A reported outcome is a fact the
    // customer told us. An inferred one is a guess we made from stop reasons
    // and error codes. They are never summed together and never shown in the
    // same column, exactly as realised and dry-run savings are kept apart.
    sql: `
      CREATE TABLE outcomes (
        tenant_id  TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        run_id     TEXT NOT NULL,
        succeeded  INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
        -- A short label the caller chooses, for grouping: 'refund-issued',
        -- 'ticket-resolved'. Never free text about what happened, which would
        -- be content.
        label      TEXT,
        reported_at INTEGER NOT NULL,
        -- One outcome per run. A run that reports twice has changed its mind,
        -- and the later answer is the one that counts.
        PRIMARY KEY (tenant_id, run_id)
      ) STRICT;

      CREATE INDEX idx_outcomes_tenant_time ON outcomes(tenant_id, reported_at);
    `,
  },
  {
    version: 10,
    name: "autopilot",
    // Letting CostGrid act on its own findings, inside limits the customer
    // sets and can revoke in one command.
    //
    // Off unless switched on, and the levels are deliberately not a slider
    // from "cautious" to "brave". `monitor` may only create rules that change
    // nothing and start measuring. `apply` may additionally switch on a
    // routing rule that already backtested positive. Nothing here may ever
    // refuse a call or set a budget: refusing breaks a customer's product, and
    // a budget is a decision belonging to whoever answers for the money.
    //
    // Every action is written here with the figures that justified it at the
    // time, so "why is this rule on my account" always has an answer, and so
    // undo is a table scan rather than an archaeology exercise.
    sql: `
      CREATE TABLE autopilot (
        tenant_id       TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        level           TEXT NOT NULL CHECK (level IN ('off', 'monitor', 'apply')),
        -- The most traffic, as a percentage of window spend, that a single
        -- action may redirect. A ceiling on blast radius, not on saving.
        max_impact_pct  INTEGER NOT NULL DEFAULT 50 CHECK (max_impact_pct BETWEEN 1 AND 100),
        -- Actions per run, so one bad window cannot rewrite a whole policy set.
        max_actions     INTEGER NOT NULL DEFAULT 3 CHECK (max_actions BETWEEN 1 AND 20),
        updated_at      INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE autopilot_actions (
        id            TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        policy_id     TEXT NOT NULL,
        kind          TEXT NOT NULL,
        -- What it did and why, in the words the customer would read.
        summary       TEXT NOT NULL,
        -- The replay figures at the moment of acting, so a decision can be
        -- re-examined against what was known then rather than what is known now.
        evidence      TEXT NOT NULL,
        level         TEXT NOT NULL,
        acted_at      INTEGER NOT NULL,
        undone_at     INTEGER
      ) STRICT;

      CREATE INDEX idx_autopilot_actions_tenant ON autopilot_actions(tenant_id, acted_at);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
