/**
 * The CostGrid schema.
 *
 * Written for SQLite because that is what a self-hosted single-tenant deploy
 * and a laptop both run with no daemon. Every construct here is deliberately
 * portable to Postgres: no SQLite-only types, integer timestamps, TEXT ids,
 * and money as INTEGER nanodollars. The repository layer is the only code that
 * speaks SQL, so swapping the driver is a contained change.
 *
 * That portability is tested rather than asserted, and the test runs the DDL
 * against an actual PostgreSQL rather than pattern-matching it. The one
 * substitution that is not optional: **SQLite's INTEGER is 64-bit and
 * Postgres's is 32-bit**, so columns holding nanodollars or millisecond
 * timestamps become BIGINT. Copying this file to Postgres unchanged would pass
 * a smoke test and overflow at $2.15 of real spend.
 *
 * Read "portable" narrowly. It means this schema applies cleanly and behaves
 * the same on both engines. It does not mean CostGrid runs on Postgres: the
 * driver is synchronous, every repository method and caller would become
 * async, placeholders change, and `strftime` in the analytics queries has no
 * Postgres equivalent. See `portability.ts` and `docs/HOSTING.md` for the
 * standing inventory of what is left.
 *
 * Multi-tenancy is present from the first migration even though the first
 * deployment is single-tenant. Retrofitting a tenant column onto a metering
 * table that already has production rows is the kind of migration that causes
 * an outage, so the column exists from the start.
 */

import { AGENTS_MIGRATION } from "./schema-agents.js";
import { OUTCOMES_MIGRATION } from "./schema-outcomes.js";
import { RESULTS_MIGRATION } from "./schema-results.js";
import { KEYS_MIGRATION } from "./schema-keys.js";
import { CONTROL_MIGRATION } from "./schema-control.js";

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
  {
    version: 11,
    name: "audit-sso-retention",
    // The three things a security review asks for that metering alone does
    // not answer: who did it, how they proved who they were, and how long any
    // of it is kept.
    //
    // These arrive together because they are one story. An audit log is only
    // evidence if the identity behind each entry is trustworthy, and a
    // retention policy that silently erased the audit log would undo both.
    sql: `
      -- The audit log: a hash chain, not a table of rows.
      --
      -- A log an administrator can edit proves nothing, and the administrator
      -- is exactly who an audit is about. Each entry therefore carries the
      -- hash of the one before it, so changing or removing any entry changes
      -- every hash after it and the chain stops verifying from that point.
      --
      -- This does not make the log unchangeable. Nothing in a database the
      -- customer owns can be. It makes a change *detectable*, which is the
      -- property the word "tamper-evident" actually names, and the one worth
      -- claiming.
      --
      -- 'seq' is per tenant and gapless. A gap is itself a finding, which is
      -- why it is not an autoincrement shared across tenants.
      CREATE TABLE audit_log (
        tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        occurred_at  INTEGER NOT NULL,

        -- Who acted. 'system' covers scheduled work with no human behind it;
        -- recording it as a person would be a small lie in the one table
        -- whose whole value is not containing any.
        actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('user', 'api-key', 'system', 'autopilot')),
        actor_id     TEXT NOT NULL,
        -- An email or key name, captured at the time. Denormalised on purpose:
        -- the log must still read correctly after the account is deleted.
        actor_label  TEXT NOT NULL,

        action       TEXT NOT NULL,
        -- What was acted on: a policy id, a provider name, an email.
        subject      TEXT NOT NULL,
        -- Canonical JSON. Never credentials, never prompt or response content.
        detail       TEXT NOT NULL,

        prev_hash    TEXT NOT NULL,
        hash         TEXT NOT NULL,

        PRIMARY KEY (tenant_id, seq)
      ) STRICT;

      CREATE INDEX idx_audit_time ON audit_log(tenant_id, occurred_at);
      CREATE INDEX idx_audit_action ON audit_log(tenant_id, action, occurred_at);

      -- Single sign-on, as OpenID Connect.
      --
      -- OIDC rather than SAML because every identity provider a customer is
      -- likely to have (Entra ID, Okta, Google Workspace, Ping) speaks it, and
      -- it needs no XML signature stack to verify safely.
      --
      -- One connection per organisation. Two would raise the question of which
      -- one governs an address, and the honest answer to that question is a
      -- feature nobody has asked for yet.
      CREATE TABLE sso_connections (
        tenant_id         TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        -- Exactly as the provider states it. Compared against the 'iss' claim
        -- on every token, so a mismatch here fails closed.
        issuer            TEXT NOT NULL,
        client_id         TEXT NOT NULL,
        -- AES-256-GCM under the same master key as provider credentials.
        encrypted_secret  TEXT NOT NULL,
        secret_hint       TEXT NOT NULL,

        -- Resolved once from the issuer's discovery document and stored, so a
        -- login does not depend on the provider's metadata endpoint being up.
        authorize_url     TEXT NOT NULL,
        token_url         TEXT NOT NULL,
        jwks_url          TEXT NOT NULL,

        -- Lower-cased email domains this connection governs, comma separated.
        -- An identity provider will happily issue a token for any address in
        -- its directory; this is what stops one tenant's connection admitting
        -- someone into another tenant.
        email_domains     TEXT NOT NULL,

        -- Give a matching address an account on first sign-in. Off means an
        -- owner must add the person first.
        auto_provision    INTEGER NOT NULL DEFAULT 1 CHECK (auto_provision IN (0, 1)),
        -- Refuse password login for addresses in email_domains. The point of
        -- buying SSO is usually that this is on.
        enforced          INTEGER NOT NULL DEFAULT 0 CHECK (enforced IN (0, 1)),
        enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      ) STRICT;

      -- One row per sign-in attempt in flight, deleted the moment it is used.
      --
      -- This is what makes the callback safe. 'state' ties the response to a
      -- request this server started, 'nonce' ties the token to it, and
      -- 'code_verifier' proves the code is being redeemed by whoever asked for
      -- it. All three are single use: the row is consumed, not read.
      CREATE TABLE sso_requests (
        state          TEXT PRIMARY KEY,
        tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        nonce          TEXT NOT NULL,
        code_verifier  TEXT NOT NULL,
        redirect_uri   TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX idx_sso_requests_expiry ON sso_requests(expires_at);

      -- How an account proves who it is. Existing rows are password accounts,
      -- which is what they are.
      --
      -- An account provisioned by SSO gets a password hash of a random value
      -- nobody has ever seen, so password login fails by construction rather
      -- than by a check somebody could forget to write. This column exists so
      -- the state is reportable, not so it is enforceable.
      ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'password';

      -- How long data is kept.
      --
      -- Three windows rather than one because the three kinds of record answer
      -- to different people. Call detail is operational, enforcement history
      -- is what a budget owner argues from, and the audit log is evidence.
      -- Zero means keep indefinitely, which is the default: deleting a
      -- customer's data because they never configured anything would be the
      -- worst possible default.
      CREATE TABLE retention (
        tenant_id    TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        -- Per-call rows, tool invocations, outcomes, imported daily usage.
        call_days    INTEGER NOT NULL DEFAULT 0 CHECK (call_days >= 0),
        -- Rule firings.
        event_days   INTEGER NOT NULL DEFAULT 0 CHECK (event_days >= 0),
        -- The audit log, with a floor. A one-week audit trail is not one, and
        -- a retention setting is a plausible way to quietly destroy evidence,
        -- so the shortest this may be is a year.
        audit_days   INTEGER NOT NULL DEFAULT 0 CHECK (audit_days = 0 OR audit_days >= 365),
        updated_at   INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 12,
    name: "anchors",
    // Sending the audit log's fingerprint somewhere CostGrid does not control.
    //
    // The hash chain makes a change detectable by whoever holds an older copy
    // of the head. Until now the only mechanism for that was telling an
    // administrator to write it down, which makes the guarantee depend on the
    // diligence of the person an audit is most likely to be about.
    //
    // An anchor is that fingerprint, signed and sent on a schedule to a system
    // the operator controls separately: a SIEM, a log collector, an auditor's
    // endpoint. What it buys is precise, and worth stating plainly rather than
    // overselling. It does not make tampering impossible: whoever controls the
    // host controls the sender and the signing key. It makes tampering
    // *loud*, because the receiver independently holds the old head and sees
    // a stream that stops, skips, or disagrees with itself.
    //
    // The anchors are therefore themselves a chain. Each one carries the
    // sequence it covers and the previous anchor's hash, so a receiver can
    // tell "nothing happened" apart from "nothing reached me".
    sql: `
      CREATE TABLE anchors (
        tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        -- Position in the anchor stream, independent of the audit sequence.
        -- A gap here is the signal a receiver watches for.
        anchor_no     INTEGER NOT NULL,
        -- The audit head this anchor commits to.
        audit_seq     INTEGER NOT NULL,
        audit_hash    TEXT NOT NULL,
        -- Links anchors to each other, so the stream cannot be thinned out
        -- without the remaining anchors disagreeing.
        prev_anchor   TEXT NOT NULL,
        -- The exact bytes that were signed, kept so a dispute can be settled
        -- against what was actually sent rather than what we would send now.
        payload       TEXT NOT NULL,
        signature     TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        -- Delivery is tracked separately from creation. An anchor that was
        -- never accepted is the interesting one.
        delivered_at  INTEGER,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        PRIMARY KEY (tenant_id, anchor_no)
      ) STRICT;

      CREATE INDEX idx_anchors_undelivered
        ON anchors(tenant_id, delivered_at, created_at);
    `,
  },
  {
    version: 13,
    name: "research-gaps",
    // Four things the research this product is built on asks for, and that
    // metering alone did not record.
    sql: `
      -- Reasoning. Reasoning tokens are where list price and real cost part
      -- company (arXiv:2603.23971). NULL means the provider did not report a
      -- figure, which is every Anthropic call: Claude does not split thinking
      -- out of output_tokens, and CostGrid does not estimate the split.
      ALTER TABLE calls ADD COLUMN reasoning_tokens INTEGER;
      -- What the request asked for: 'effort:high', 'budget:8000', 'thinking'.
      ALTER TABLE calls ADD COLUMN reasoning_requested TEXT;

      -- The rule register. Business rules that end up executing inside
      -- automated systems need an owner, a reason and a history, or they
      -- become what Hydari and Muzaffar call rule debt (arXiv:2605.23179).
      -- 'live_since' is when the rule last started enforcing, which is the
      -- line a before-and-after measurement is drawn at.
      ALTER TABLE policies ADD COLUMN owner TEXT;
      ALTER TABLE policies ADD COLUMN reason TEXT;
      ALTER TABLE policies ADD COLUMN live_since INTEGER;
      UPDATE policies SET live_since = created_at WHERE enabled = 1 AND action != 'monitor';

      -- Where alerts go. The webhook address is a credential (a Slack
      -- incoming webhook is one), so it is encrypted under the master key like
      -- a provider key and shown back only as a masked hint.
      CREATE TABLE alert_settings (
        tenant_id          TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        encrypted_webhook  TEXT,
        webhook_hint       TEXT,
        -- A notification on this computer, for the desktop app.
        desktop            INTEGER NOT NULL DEFAULT 1 CHECK (desktop IN (0, 1)),
        updated_at         INTEGER NOT NULL
      ) STRICT;

      -- Every alert raised, delivered or not. 'dedupe_key' is what stops a
      -- budget that is over its limit from alerting on every call after it:
      -- one alert per rule per window, per run, or per hour, by kind.
      CREATE TABLE alerts (
        id            TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,
        dedupe_key    TEXT NOT NULL,
        subject       TEXT NOT NULL,
        message       TEXT NOT NULL,
        occurred_at   INTEGER NOT NULL,
        delivered_at  INTEGER,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        UNIQUE (tenant_id, dedupe_key)
      ) STRICT;
      CREATE INDEX idx_alerts_tenant_time ON alerts(tenant_id, occurred_at);

      -- Costs that never appear on a model provider's invoice. Tokens are one
      -- of seven categories in EY's total cost of agents; the others land on
      -- other budgets. Entered by hand, monthly, and always shown apart from
      -- metered spend so a typed-in figure is never mistaken for a measured one.
      CREATE TABLE fixed_costs (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        label           TEXT NOT NULL,
        category        TEXT NOT NULL CHECK (category IN
                          ('subscriptions', 'platform', 'governance', 'change', 'failure', 'other')),
        scope_kind      TEXT NOT NULL CHECK (scope_kind IN ('tenant', 'department', 'agent')),
        scope_value     TEXT,
        monthly_amount  INTEGER NOT NULL CHECK (monthly_amount >= 0),
        -- First and last calendar month it applies to, as YYYY-MM.
        starts_month    TEXT NOT NULL,
        ends_month      TEXT,
        created_at      INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX idx_fixed_costs_tenant ON fixed_costs(tenant_id);
    `,
  },
  {
    version: 14,
    name: "owner-setup",
    // What an owner needs to get from install to their own costs without
    // writing code: a connected admin key, the workflows found in its usage,
    // and what each of those workflows is for.
    sql: `
      -- A stored admin key, described but never held. The secret lives in the
      -- operating system's keychain; this row is what the console shows and
      -- what the sync job schedules from, and a leak of it hands nobody a
      -- credential.
      CREATE TABLE admin_keys (
        tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider          TEXT NOT NULL,
        -- The masked form, so the owner can tell which key it was.
        key_hint          TEXT NOT NULL,
        -- When the owner said it stops working. NULL means never.
        expires_at        INTEGER,
        created_at        INTEGER NOT NULL,
        last_sync_at      INTEGER,
        last_sync_status  TEXT CHECK (last_sync_status IN ('ok', 'error')),
        last_sync_error   TEXT,
        PRIMARY KEY (tenant_id, provider)
      ) STRICT;

      -- Each place usage came from: an API key, a Claude workspace, an OpenAI
      -- project, or the whole account when the provider did not say. This is
      -- the row an owner names and gives a purpose to.
      --
      -- 'source_id' is whatever the provider identifies it by: an id from the
      -- admin API, or a name from a usage file, which is all the file holds.
      -- '' for the account, so the primary key never contains a NULL.
      CREATE TABLE usage_sources (
        tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider         TEXT NOT NULL,
        source_kind      TEXT NOT NULL CHECK (source_kind IN ('key', 'workspace', 'project', 'account')),
        source_id        TEXT NOT NULL,
        -- The workspace or project a key belongs to, where known.
        parent_id        TEXT,
        -- The provider's own name for it, looked up rather than typed.
        provider_label   TEXT,
        -- The owner's name for it.
        display_name     TEXT,
        -- Which preset it is for, and the preset version that was chosen, so a
        -- later change to a preset's definition does not rewrite history.
        purpose_id       TEXT,
        purpose_version  TEXT,
        named_at         INTEGER,
        -- First and last UTC day it was seen with usage, as YYYY-MM-DD.
        first_day        TEXT,
        last_day         TEXT,
        created_at       INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, provider, source_kind, source_id)
      ) STRICT;

      -- Imported usage, now kept per source and labelled with how it arrived.
      --
      -- A rebuild rather than ALTER TABLE because the unique key changes, and
      -- SQLite cannot alter a constraint in place. Existing rows were summed
      -- across every key and workspace, so they become the account's: true,
      -- and the next import over the same days replaces them outright.
      CREATE TABLE imported_usage_v14 (
        id                    TEXT PRIMARY KEY,
        tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider              TEXT NOT NULL,
        day                   TEXT NOT NULL,
        model                 TEXT NOT NULL,
        source_kind           TEXT NOT NULL DEFAULT 'account'
                                CHECK (source_kind IN ('key', 'workspace', 'project', 'account')),
        source_id             TEXT NOT NULL DEFAULT '',
        -- An admin API pull, or a usage file the owner uploaded.
        origin                TEXT NOT NULL DEFAULT 'admin-api' CHECK (origin IN ('admin-api', 'csv')),

        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        requests              INTEGER NOT NULL DEFAULT 0,

        cost_catalog          INTEGER NOT NULL DEFAULT 0,
        priced                INTEGER NOT NULL DEFAULT 1 CHECK (priced IN (0, 1)),
        cost_reported         INTEGER,

        imported_at           INTEGER NOT NULL,
        UNIQUE (tenant_id, provider, day, model, source_kind, source_id)
      ) STRICT;

      INSERT INTO imported_usage_v14 (
        id, tenant_id, provider, day, model,
        input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
        cache_read_tokens, requests, cost_catalog, priced, cost_reported, imported_at
      )
      SELECT
        id, tenant_id, provider, day, model,
        input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
        cache_read_tokens, requests, cost_catalog, priced, cost_reported, imported_at
      FROM imported_usage;

      DROP TABLE imported_usage;
      ALTER TABLE imported_usage_v14 RENAME TO imported_usage;
      CREATE INDEX idx_imported_tenant_day ON imported_usage(tenant_id, day);

      -- So history imported before this version still appears in the list of
      -- sources, as the whole account, rather than as cost with no owner.
      INSERT INTO usage_sources (tenant_id, provider, source_kind, source_id, first_day, last_day, created_at)
      SELECT tenant_id, provider, 'account', '', MIN(day), MAX(day), MAX(imported_at)
      FROM imported_usage
      GROUP BY tenant_id, provider;

      -- How each run's rows arrived. Every run before this one used a key.
      ALTER TABLE import_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'admin-api';
    `,
  },
  AGENTS_MIGRATION,
  OUTCOMES_MIGRATION,
  RESULTS_MIGRATION,
  KEYS_MIGRATION,
  CONTROL_MIGRATION,
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
