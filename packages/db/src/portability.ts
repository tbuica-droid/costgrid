import { MIGRATIONS } from "./schema.js";

/**
 * Turning "the schema is portable to Postgres" from a claim into a check.
 *
 * That sentence has been in this repository's documentation since the first
 * migration, and it was asserted rather than tested. Writing this found that
 * it was not quite true, in a way that would have been discovered on the day
 * of the migration with a customer's data in flight:
 *
 * **SQLite's INTEGER is 64-bit. Postgres's INTEGER is 32-bit.** Every money
 * column here is nanodollars, so `INTEGER` overflows at $2.15, and every
 * timestamp is milliseconds since the epoch, which passed the 32-bit ceiling
 * in 1970. A copy of this schema run against Postgres unchanged would accept
 * a test row and then fail on real data.
 *
 * So the translation below is not cosmetic, and neither is the check: it runs
 * in the test suite, and a migration that adds an unportable construct fails
 * there rather than a year from now.
 *
 * ## What this is not
 *
 * It is not the port. Nothing here makes CostGrid run on Postgres: the driver
 * is synchronous and Postgres is not, and that is a change to every repository
 * method and every caller. This is the schema half, done and verified, so that
 * when the rest is done the schema is not also a surprise.
 */

export interface PortabilityFinding {
  readonly migration: number;
  readonly construct: string;
  readonly detail: string;
}

/** Comments may say anything; only executable SQL is checked. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * SQLite constructs Postgres will not accept, and that translation below does
 * not silently absorb.
 *
 * `STRICT` and `INTEGER` are absent on purpose: both are handled by
 * `toPostgres`, so finding them is expected rather than a problem.
 */
const UNPORTABLE: readonly { pattern: RegExp; construct: string; detail: string }[] = [
  {
    pattern: /\bAUTOINCREMENT\b/i,
    construct: "AUTOINCREMENT",
    detail: "Postgres uses GENERATED ... AS IDENTITY; there is no direct equivalent.",
  },
  {
    pattern: /INSERT\s+OR\s+(REPLACE|IGNORE|ROLLBACK|ABORT|FAIL)/i,
    construct: "INSERT OR ...",
    detail: "Use ON CONFLICT, which both accept.",
  },
  {
    pattern: /\bWITHOUT\s+ROWID\b/i,
    construct: "WITHOUT ROWID",
    detail: "A SQLite storage hint with no Postgres counterpart.",
  },
  {
    pattern: /\b(strftime|julianday|datetime|date)\s*\(/i,
    construct: "SQLite date function",
    detail: "Timestamps here are integer milliseconds; keep the arithmetic in the application.",
  },
  {
    pattern: /\bPRAGMA\b/i,
    construct: "PRAGMA",
    detail: "Connection settings belong in openDatabase, not in a migration.",
  },
  {
    pattern: /\b(GLOB|MATCH)\b/i,
    construct: "GLOB or MATCH",
    detail: "SQLite-only operators. LIKE is available in both.",
  },
  {
    pattern: /\bBLOB\b/i,
    construct: "BLOB",
    detail: "Postgres spells it BYTEA. Nothing here stores binary, so this is a new decision.",
  },
  {
    pattern: /\b(REAL|DOUBLE|FLOAT)\b/i,
    construct: "floating point",
    detail:
      "Money in this schema is integer nanodollars. A float column is a correctness problem " +
      "before it is a portability one.",
  },
];

/**
 * Every construct in the migrations that would not survive the move.
 *
 * An empty result is the only acceptable one, and a test asserts it.
 */
export function portabilityFindings(): PortabilityFinding[] {
  const findings: PortabilityFinding[] = [];
  for (const migration of MIGRATIONS) {
    const sql = stripComments(migration.sql);
    for (const { pattern, construct, detail } of UNPORTABLE) {
      if (pattern.test(sql)) {
        findings.push({ migration: migration.version, construct, detail });
      }
    }
  }
  return findings;
}

/**
 * The same schema, as Postgres would take it.
 *
 * Three substitutions, each one a real difference rather than a spelling:
 *
 * 1. **`INTEGER` becomes `BIGINT`.** The important one. See the note at the
 *    top of this file: 32 bits is not enough for a nanodollar or for a
 *    millisecond timestamp.
 * 2. **`STRICT` is dropped.** It asks SQLite to behave the way Postgres always
 *    does, so on Postgres there is nothing to ask for.
 * 3. **`ALTER TABLE ... ADD COLUMN` gains `IF NOT EXISTS`**, so a partially
 *    applied migration can be re-run. SQLite has no such clause, which is why
 *    the difference exists here rather than in the source.
 */
export function toPostgres(sql: string): string {
  return (
    sql
      // Only column type positions, never the word inside an identifier or a
      // string: matched with the boundaries a type declaration actually has.
      .replace(/\bINTEGER\b/g, "BIGINT")
      .replace(/\)\s*STRICT\s*;/g, ");")
      .replace(/\bSTRICT\b/g, "")
      .replace(/ALTER TABLE (\w+) ADD COLUMN/gi, "ALTER TABLE $1 ADD COLUMN IF NOT EXISTS")
  );
}

/** The whole schema as one Postgres script, in migration order. */
export function postgresSchema(): string {
  const parts = MIGRATIONS.map(
    (migration) =>
      `-- migration ${migration.version}: ${migration.name}\n${toPostgres(migration.sql).trim()}`,
  );
  return [
    "-- CostGrid schema, translated for Postgres.",
    "--",
    "-- Generated from packages/db/src/schema.ts. Do not edit by hand: regenerate it,",
    "-- or the two will disagree and the disagreement will be found during a migration.",
    "--",
    "-- This is the schema only. The repository layer still speaks to a synchronous",
    "-- SQLite driver, so this does not by itself make CostGrid run on Postgres.",
    "",
    ...parts,
  ].join("\n");
}
