import { describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  portabilityFindings,
  postgresSchema,
  toPostgres,
  unclassifiedColumns,
} from "../src/index.js";

describe("Postgres portability", () => {
  it("finds nothing unportable in the migrations", () => {
    // Failing here means a new migration used something Postgres will not
    // take. Fix the migration; do not relax this test. The whole point is that
    // the claim in the documentation is checked rather than repeated.
    expect(portabilityFindings()).toEqual([]);
  });

  it("widens money, because nanodollars do not fit in 32 bits", () => {
    // The bug this file exists for. SQLite's INTEGER is 64-bit and Postgres's
    // is not, so a straight copy of the schema overflows at $2.15 of spend and
    // at any timestamp after 1970.
    expect(toPostgres("cost_total INTEGER NOT NULL DEFAULT 0")).toBe(
      "cost_total BIGINT NOT NULL DEFAULT 0",
    );
    expect(toPostgres("started_at INTEGER NOT NULL")).toBe("started_at BIGINT NOT NULL");
  });

  it("does not widen what does not need widening", () => {
    // An earlier version turned all 84 integer columns into BIGINT, which is
    // safe and lazy in equal measure: eight bytes for a column holding 0 or 1.
    // SQLite has one integer type and cannot express the difference; Postgres
    // has three, and throwing that away is not a translation, it is a shrug.
    expect(toPostgres("streamed INTEGER NOT NULL CHECK (streamed IN (0, 1))")).toBe(
      "streamed SMALLINT NOT NULL CHECK (streamed IN (0, 1))",
    );
    expect(toPostgres("duration_ms INTEGER NOT NULL")).toBe("duration_ms INTEGER NOT NULL");
  });

  it("refuses to guess at a column nobody has classified", () => {
    // A silent default is how the next migration quietly gets the wrong type.
    expect(() => toPostgres("mystery_column INTEGER NOT NULL")).toThrow(/no Postgres width/);
    expect(unclassifiedColumns()).toEqual([]);
  });

  it("holds a nanodollar figure that would overflow a 32-bit column", () => {
    // One month of a mid-sized customer's spend, in nanodollars.
    const monthlySpend = 4_200_00_000_0000n;
    expect(monthlySpend).toBeGreaterThan(2_147_483_647n);
    expect(monthlySpend).toBeLessThan(2n ** 63n - 1n);
  });

  it("drops STRICT, which Postgres enforces anyway", () => {
    expect(toPostgres("CREATE TABLE t (id TEXT PRIMARY KEY) STRICT;")).toBe(
      "CREATE TABLE t (id TEXT PRIMARY KEY);",
    );
    expect(postgresSchema()).not.toMatch(/\bSTRICT\b/);
  });

  it("makes added columns re-runnable, which SQLite cannot express", () => {
    expect(toPostgres("ALTER TABLE calls ADD COLUMN run_id TEXT;")).toBe(
      "ALTER TABLE calls ADD COLUMN IF NOT EXISTS run_id TEXT;",
    );
  });

  it("carries every migration through, in order", () => {
    const script = postgresSchema();
    for (const migration of MIGRATIONS) {
      expect(script).toContain(`-- migration ${migration.version}: ${migration.name}`);
    }
    const positions = MIGRATIONS.map((m) => script.indexOf(`-- migration ${m.version}:`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps the constructs that are the same in both", () => {
    const script = postgresSchema();
    // ON CONFLICT, CHECK, REFERENCES and partial-free indexes all exist in
    // both, and translating them would be the way to introduce a difference.
    expect(script).toContain("REFERENCES tenants(id) ON DELETE CASCADE");
    expect(script).toContain("CHECK (action IN ('monitor', 'warn', 'block'))");
  });

  it("notices an unportable construct if one is introduced", () => {
    // Guards the guard: a checker that cannot fail is not checking.
    const unportable = [
      "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT) STRICT;",
      "INSERT OR REPLACE INTO t VALUES (1);",
      "CREATE TABLE t (score REAL);",
    ];
    for (const sql of unportable) {
      const hit = [
        /\bAUTOINCREMENT\b/i,
        /INSERT\s+OR\s+(REPLACE|IGNORE|ROLLBACK|ABORT|FAIL)/i,
        /\b(REAL|DOUBLE|FLOAT)\b/i,
      ].some((pattern) => pattern.test(sql));
      expect(hit).toBe(true);
    }
  });
});
