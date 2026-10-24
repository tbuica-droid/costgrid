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
 * Blank out comments without moving anything.
 *
 * The first version of the source scanner reused `stripComments`, which
 * deletes comment bodies and therefore deletes their newlines. Every line
 * number it reported afterwards was wrong, and it blamed two findings on a
 * file that had none. Replacing each comment character with a space keeps
 * every offset where it was, so a reported line is the line somebody opens.
 */
function blankComments(source: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
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
    // String literals are data: a CHECK allowing 'match' is not the MATCH operator.
    const sql = stripComments(migration.sql).replace(/'(?:[^']|'')*'/g, "''");
    for (const { pattern, construct, detail } of UNPORTABLE) {
      if (pattern.test(sql)) {
        findings.push({ migration: migration.version, construct, detail });
      }
    }
  }
  return findings;
}

/**
 * What each integer column actually holds, and therefore how wide it must be.
 *
 * The first version of this file widened every `INTEGER` to `BIGINT`, which is
 * safe and lazy in equal measure. SQLite has one integer type so the schema
 * cannot express the difference; Postgres has three, and throwing that away
 * means an eight-byte column for a flag that holds 0 or 1.
 *
 * So the mapping is explicit, and unknown columns are a build failure rather
 * than a default. A silent default is how the next migration quietly gets the
 * wrong type, and the whole argument for this file is that assumptions about
 * the Postgres schema should fail loudly and early.
 *
 * Flags stay numeric rather than becoming `boolean`. Postgres `boolean` would
 * be the idiomatic choice, and it is deliberately not taken here: the
 * repository layer reads these as 0 and 1 today, so changing the type is an
 * application decision with tests attached, not something a DDL translator
 * should do behind everyone's back. `SMALLINT` keeps the behaviour and still
 * costs two bytes instead of eight.
 */
const COLUMN_WIDTHS: Readonly<Record<string, "BIGINT" | "INTEGER" | "SMALLINT">> = {
  // Money, in nanodollars. 1 USD = 1e9, so int4 overflows at $2.15.
  cost_total: "BIGINT",
  cost_input: "BIGINT",
  cost_output: "BIGINT",
  cost_cache_read: "BIGINT",
  cost_cache_write: "BIGINT",
  cost_list: "BIGINT",
  cost_catalog: "BIGINT",
  cost_reported: "BIGINT",
  saving_estimate: "BIGINT",
  monthly_amount: "BIGINT",
  evidence_catalog: "BIGINT",
  evidence_reported: "BIGINT",

  // Milliseconds since the epoch. Passed int4 in 1970.
  created_at: "BIGINT",
  started_at: "BIGINT",
  occurred_at: "BIGINT",
  updated_at: "BIGINT",
  revoked_at: "BIGINT",
  expires_at: "BIGINT",
  last_login_at: "BIGINT",
  first_seen: "BIGINT",
  last_seen: "BIGINT",
  first_seen_at: "BIGINT",
  last_seen_at: "BIGINT",
  imported_at: "BIGINT",
  finished_at: "BIGINT",
  reported_at: "BIGINT",
  acted_at: "BIGINT",
  undone_at: "BIGINT",
  evidence_from: "BIGINT",
  evidence_to: "BIGINT",
  live_since: "BIGINT",
  last_sync_at: "BIGINT",
  named_at: "BIGINT",

  // Token counts. A single call never approaches int4, but these are summed
  // across windows constantly and a rate override multiplies them, so the
  // headroom is worth four bytes.
  input_tokens: "BIGINT",
  reasoning_tokens: "BIGINT",
  output_tokens: "BIGINT",
  cache_read_tokens: "BIGINT",
  cache_write_5m_tokens: "BIGINT",
  cache_write_1h_tokens: "BIGINT",

  // A rational rate, multiplied into money. Same arithmetic, same width.
  numerator: "BIGINT",
  denominator: "BIGINT",

  // Monotonic per-tenant counters with no natural ceiling.
  seq: "BIGINT",
  anchor_no: "BIGINT",
  // Mirrors the audit sequence it commits to, so it must be as wide.
  audit_seq: "BIGINT",

  // Flags: 0 or 1, with a CHECK constraint that says so.
  streamed: "SMALLINT",
  priced: "SMALLINT",
  routed: "SMALLINT",
  route_dry_run: "SMALLINT",
  run_declared: "SMALLINT",
  enabled: "SMALLINT",
  enforced: "SMALLINT",
  auto_provision: "SMALLINT",
  succeeded: "SMALLINT",
  desktop: "SMALLINT",

  // Small bounded quantities. int4 is already far more than any of them needs.
  duration_ms: "INTEGER",
  run_depth: "INTEGER",
  status_code: "INTEGER",
  requests: "INTEGER",
  rows_written: "INTEGER",
  batch: "INTEGER",
  max_impact_pct: "INTEGER",
  max_actions: "INTEGER",
  attempts: "INTEGER",
  delivered_at: "BIGINT",
  call_days: "INTEGER",
  event_days: "INTEGER",
  audit_days: "INTEGER",
  version: "INTEGER",
  applied_at: "BIGINT",
  // Agents and the sources they use.
  shared: "SMALLINT",
  assigned_at: "BIGINT",
};

/** An integer column in the migrations that nobody has decided a width for. */
export function unclassifiedColumns(): string[] {
  const sql = MIGRATIONS.map((m) => stripComments(m.sql)).join("\n");
  const names = new Set<string>();
  for (const match of sql.matchAll(/^\s*(\w+)\s+INTEGER\b/gm)) names.add(match[1]!);
  for (const match of sql.matchAll(/ADD COLUMN (\w+) INTEGER\b/g)) names.add(match[1]!);
  return [...names].filter((name) => COLUMN_WIDTHS[name] === undefined).sort();
}

/**
 * The same schema, as Postgres would take it.
 *
 * Three kinds of substitution, each a real difference rather than a spelling:
 *
 * 1. **Integer widths**, from the table above. The one that matters: SQLite's
 *    INTEGER is 64-bit and Postgres's is 32-bit, so a nanodollar column left
 *    as `INTEGER` overflows at $2.15 and a millisecond timestamp overflowed
 *    decades ago.
 * 2. **`STRICT` is dropped.** It asks SQLite to behave the way Postgres
 *    already does, so there is nothing to ask for.
 * 3. **`ALTER TABLE ... ADD COLUMN` gains `IF NOT EXISTS`**, so a partly
 *    applied migration can be re-run. SQLite has no such clause, which is why
 *    the difference lives here rather than in the source.
 */
export function toPostgres(sql: string): string {
  const width = (name: string): string => {
    const mapped = COLUMN_WIDTHS[name];
    if (mapped === undefined) {
      throw new Error(
        `no Postgres width decided for integer column "${name}". Add it to COLUMN_WIDTHS ` +
          "in portability.ts, choosing BIGINT for money, timestamps and anything summed.",
      );
    }
    return mapped;
  };

  return sql
    .replace(/^(\s*)(\w+)(\s+)INTEGER\b/gm, (_m, indent: string, name: string, gap: string) =>
      `${indent}${name}${gap}${width(name)}`,
    )
    .replace(/ADD COLUMN (\w+) INTEGER\b/g, (_m, name: string) => `ADD COLUMN ${name} ${width(name)}`)
    .replace(/\)\s*STRICT\s*;/g, ");")
    .replace(/\bSTRICT\b/g, "")
    .replace(/ALTER TABLE (\w+) ADD COLUMN/gi, "ALTER TABLE $1 ADD COLUMN IF NOT EXISTS");
}

/**
 * SQLite-only constructs in the repository code, as opposed to the migrations.
 *
 * This exists because the first version of this file had a blind spot it was
 * written specifically to prevent. It scanned migrations and nothing else, so
 * `PRAGMA table_info` and `sqlite_master` went into `retention.ts` the same
 * week and the checker reported the schema as fully portable. A portability
 * check that only looks at the schema will keep saying yes while the code
 * around it drifts.
 *
 * The caller passes the sources, because this package cannot read its own
 * files at runtime once compiled.
 */
export function unportableQueries(
  sources: readonly { readonly file: string; readonly text: string }[],
): { file: string; line: number; construct: string; detail: string }[] {
  const patterns: readonly { pattern: RegExp; construct: string; detail: string }[] = [
    {
      pattern: /\bPRAGMA\b/i,
      construct: "PRAGMA",
      detail: "Postgres exposes the same facts through information_schema.",
    },
    {
      pattern: /\bsqlite_master\b/i,
      construct: "sqlite_master",
      detail: "Use information_schema.tables and .columns instead.",
    },
    {
      pattern: /\bINSERT\s+OR\s+(REPLACE|IGNORE)\b/i,
      construct: "INSERT OR ...",
      detail: "ON CONFLICT works in both.",
    },
    {
      pattern: /\b(strftime|julianday)\s*\(/i,
      construct: "SQLite date function",
      detail: "Timestamps here are integer milliseconds; keep the arithmetic in TypeScript.",
    },
  ];

  const findings: { file: string; line: number; construct: string; detail: string }[] = [];
  for (const { file, text } of sources) {
    const lines = blankComments(text).split("\n");
    lines.forEach((line, index) => {
      for (const { pattern, construct, detail } of patterns) {
        if (pattern.test(line)) findings.push({ file, line: index + 1, construct, detail });
      }
    });
  }
  return findings;
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
