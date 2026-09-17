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

  it("declares versions that are unique and ascending", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...new Set(versions)]);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });
});
