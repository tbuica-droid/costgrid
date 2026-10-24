import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/database.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/schema.js";

/**
 * Migrations run against databases that already hold a customer's billing
 * history. An upgrade that drops a row or fails halfway is unrecoverable
 * without a backup, so each one is exercised against a populated database
 * built at the previous version rather than a fresh one.
 */
function buildAtVersion(version: number): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of MIGRATIONS.filter((m) => m.version <= version)) {
    db.exec(migration.sql);
    record.run(migration.version, migration.name, Date.now());
  }
  return db;
}

function appliedVersions(db: Database.Database): number[] {
  return db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((r) => (r as { version: number }).version);
}

describe("migrations", () => {
  it("brings a fresh database to the current version", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(appliedVersions(db).at(-1)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent — re-running applies nothing", () => {
    const db = openDatabase({ path: ":memory:" });
    const before = appliedVersions(db);
    migrate(db);
    migrate(db);
    expect(appliedVersions(db)).toEqual(before);
    db.close();
  });

  it("upgrades a populated v1 database without losing data", () => {
    const db = buildAtVersion(1);
    expect(appliedVersions(db)).toEqual([1]);

    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    db.prepare(
      `INSERT INTO calls (
         id, tenant_id, agent_id, department, provider, model,
         started_at, duration_ms, streamed, cost_total, outcome
       ) VALUES ('c1', 't1', 'a', 'Eng', 'anthropic', 'claude-opus-5', 1000, 5, 0, 42, 'ok')`,
    ).run();

    migrate(db);

    // Asserted against SCHEMA_VERSION rather than a literal, so adding a
    // migration does not require editing this test — only the assertions
    // about what that migration actually did.
    expect(appliedVersions(db).at(-1)).toBe(SCHEMA_VERSION);
    expect(appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));

    const row = db.prepare("SELECT * FROM calls WHERE id = 'c1'").get() as Record<string, unknown>;
    // Pre-existing data survives, and the new columns take sane defaults:
    // an old row has no recorded modifiers, which is different from "standard".
    expect(row["cost_total"]).toBe(42);
    expect(row["model"]).toBe("claude-opus-5");
    expect(row["speed"]).toBeNull();
    expect(row["inference_geo"]).toBeNull();
    expect(row["batch"]).toBe(0);

    db.close();
  });

  it("adds control-plane tables without touching metering data", () => {
    const db = buildAtVersion(2);
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    db.prepare(
      `INSERT INTO calls (
         id, tenant_id, agent_id, department, provider, model,
         started_at, duration_ms, streamed, cost_total, outcome
       ) VALUES ('c1', 't1', 'a', 'Eng', 'anthropic', 'claude-opus-5', 1000, 5, 0, 99, 'ok')`,
    ).run();

    migrate(db);

    // The metering row is untouched...
    expect(
      (db.prepare("SELECT cost_total AS c FROM calls WHERE id = 'c1'").get() as { c: number }).c,
    ).toBe(99);

    // ...and the new tables exist and are empty. An existing tenant has no
    // subscription row, which AccountsRepository reads as the free plan.
    for (const table of ["users", "memberships", "sessions", "provider_credentials", "subscriptions"]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n, table).toBe(0);
    }

    db.close();
  });

  it("adds routing columns without disturbing existing calls", () => {
    const db = buildAtVersion(4);
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    db.prepare(
      `INSERT INTO calls (
         id, tenant_id, agent_id, department, provider, model,
         started_at, duration_ms, streamed, cost_total, outcome
       ) VALUES ('c1', 't1', 'a', 'Eng', 'anthropic', 'claude-opus-5', 1000, 5, 0, 77, 'ok')`,
    ).run();

    migrate(db);

    const row = db.prepare("SELECT * FROM calls WHERE id = 'c1'").get() as Record<string, unknown>;
    expect(row["cost_total"]).toBe(77);
    // A pre-existing call was never routed, and must not read as a zero saving
    // on a substitution that never happened — requested_model stays null.
    expect(row["requested_model"]).toBeNull();
    expect(row["routed"]).toBe(0);
    expect(row["route_dry_run"]).toBe(0);
    expect(row["saving_estimate"]).toBe(0);

    db.close();
  });

  it("backfills every historical call into a run of its own", () => {
    const db = buildAtVersion(5);
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    for (const id of ["c1", "c2"]) {
      db.prepare(
        `INSERT INTO calls (
           id, tenant_id, agent_id, department, provider, model,
           started_at, duration_ms, streamed, cost_total, outcome
         ) VALUES (?, 't1', 'a', 'Eng', 'anthropic', 'claude-opus-5', 1000, 5, 0, 77, 'ok')`,
      ).run(id);
    }

    migrate(db);

    const rows = db
      .prepare("SELECT id, run_id, parent_run_id, run_depth, run_declared, cost_total FROM calls ORDER BY id")
      .all() as Record<string, unknown>[];

    // Every past call really was a run of one, as far as anything here can
    // know. Leaving run_id null would force a null branch into every query
    // that groups by run, forever.
    expect(rows.map((r) => r["run_id"])).toEqual(["c1", "c2"]);
    for (const row of rows) {
      expect(row["parent_run_id"]).toBeNull();
      expect(row["run_depth"]).toBe(0);
      // Nobody declared these, and a run rule must not appear to cover them.
      expect(row["run_declared"]).toBe(0);
      expect(row["cost_total"]).toBe(77);
    }

    db.close();
  });

  it("backfills list price to equal what was charged before any rate existed", () => {
    const db = buildAtVersion(7);
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    db.prepare(
      `INSERT INTO calls (
         id, tenant_id, agent_id, department, provider, model,
         started_at, duration_ms, streamed, cost_total, outcome
       ) VALUES ('c1', 't1', 'a', 'Eng', 'anthropic', 'claude-opus-5', 1000, 5, 0, 4242, 'ok')`,
    ).run();

    migrate(db);

    const row = db.prepare("SELECT cost_total, cost_list FROM calls WHERE id = 'c1'").get() as
      Record<string, number>;
    // No discount was applied to history, so list and charged are the same
    // figure. Zeroing cost_list instead would make every past month look like
    // a 100% discount.
    expect(row["cost_total"]).toBe(4242);
    expect(row["cost_list"]).toBe(4242);

    db.close();
  });

  it("keeps imported history as the account's when usage gains sources", () => {
    const db = buildAtVersion(13);
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    const insert = db.prepare(
      `INSERT INTO imported_usage (id, tenant_id, provider, day, model, input_tokens, cost_catalog,
                                   cost_reported, imported_at)
       VALUES (?, 't1', ?, ?, ?, ?, ?, ?, 5000)`,
    );
    insert.run("u1", "anthropic", "2026-06-01", "claude-opus-5", 1000, 30_000_000_000, null);
    insert.run("u2", "anthropic", "2026-06-02", "claude-opus-5", 2000, 60_000_000_000, 50_000_000_000);
    insert.run("u3", "openai", "2026-06-03", "gpt-5", 3000, 1_000_000_000, null);
    db.prepare(
      `INSERT INTO import_runs (id, tenant_id, provider, started_at, from_day, to_day, status)
       VALUES ('r1', 't1', 'anthropic', 1, '2026-06-01', '2026-06-02', 'ok')`,
    ).run();

    migrate(db);

    const rows = db
      .prepare(
        `SELECT id, source_kind, source_id, origin, input_tokens, cost_catalog, cost_reported
         FROM imported_usage ORDER BY id`,
      )
      .all();
    expect(rows).toEqual([
      { id: "u1", source_kind: "account", source_id: "", origin: "admin-api", input_tokens: 1000, cost_catalog: 30_000_000_000, cost_reported: null },
      { id: "u2", source_kind: "account", source_id: "", origin: "admin-api", input_tokens: 2000, cost_catalog: 60_000_000_000, cost_reported: 50_000_000_000 },
      { id: "u3", source_kind: "account", source_id: "", origin: "admin-api", input_tokens: 3000, cost_catalog: 1_000_000_000, cost_reported: null },
    ]);
    expect(db.prepare("SELECT origin FROM import_runs WHERE id = 'r1'").get()).toEqual({ origin: "admin-api" });

    // The history shows up as the whole account in each provider's sources.
    expect(
      db
        .prepare(
          `SELECT provider, source_kind, source_id, first_day, last_day, created_at
           FROM usage_sources ORDER BY provider`,
        )
        .all(),
    ).toEqual([
      { provider: "anthropic", source_kind: "account", source_id: "", first_day: "2026-06-01", last_day: "2026-06-02", created_at: 5000 },
      { provider: "openai", source_kind: "account", source_id: "", first_day: "2026-06-03", last_day: "2026-06-03", created_at: 5000 },
    ]);

    // The new unique key lets two sources share a day and model...
    db.prepare(
      `INSERT INTO imported_usage (id, tenant_id, provider, day, model, source_kind, source_id, imported_at)
       VALUES ('u4', 't1', 'anthropic', '2026-06-01', 'claude-opus-5', 'key', 'apikey_a', 1)`,
    ).run();
    // ...but not one source twice.
    expect(() =>
      db
        .prepare(
          `INSERT INTO imported_usage (id, tenant_id, provider, day, model, source_kind, source_id, imported_at)
           VALUES ('u5', 't1', 'anthropic', '2026-06-01', 'claude-opus-5', 'key', 'apikey_a', 1)`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
    // And the index the day-range reads rely on came back.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_imported_tenant_day'").get(),
    ).toBeDefined();

    db.close();
  });

  it("declares versions that are unique and ascending", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...new Set(versions)]);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });
});
