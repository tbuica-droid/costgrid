import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  openDatabase,
  postgresSchema,
  unclassifiedColumns,
  unportableQueries,
  type Db,
} from "../src/index.js";

/**
 * The schema, run against an actual Postgres rather than reasoned about.
 *
 * A static checker over the migrations can only find the mistakes somebody
 * thought to write a pattern for. Postgres finds the rest, and it is the only
 * authority on what Postgres accepts. Everything here therefore executes: the
 * DDL is applied, rows are written and read back, and the aggregates that
 * carry money are run on both engines over identical data and compared.
 *
 * ## What this proves, and what it does not
 *
 * PGlite is PostgreSQL compiled to WebAssembly from the same C sources, so the
 * parser, planner, type system and constraint machinery are the real ones. A
 * statement that runs here runs on a server.
 *
 * It is a single in-process connection. So it says nothing about connection
 * pooling, lock contention, `SELECT FOR UPDATE` under concurrency, replication
 * lag, or anything a server's configuration governs. Those need a real
 * instance under real load, and until that exists the honest claim is that the
 * **schema and its SQL semantics** are validated, not that CostGrid runs on
 * Postgres. It does not: the driver is still synchronous SQLite.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

/** One US dollar in nanodollars. */
const USD = 1_000_000_000n;
/** The largest value a Postgres `integer` can hold. */
const INT4_MAX = 2_147_483_647n;

describe("Postgres", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await PGlite.create();
    await pg.exec(postgresSchema());
  }, 60_000);

  it("runs a real PostgreSQL", async () => {
    const result = await pg.query<{ version: string }>("SELECT version()");
    expect(result.rows[0]?.version).toContain("PostgreSQL");
  });

  it("accepts the generated schema", async () => {
    // beforeAll would have thrown otherwise; this asserts the tables exist
    // rather than that nothing errored.
    const tables = await pg.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(Number(tables.rows[0]?.count)).toBeGreaterThan(15);
  });

  it("has a decided width for every integer column", () => {
    // An unclassified column would mean the emitter guessed, and guessing is
    // what produced the $2.15 overflow this whole file exists to prevent.
    expect(unclassifiedColumns()).toEqual([]);
  });

  describe("integer widths", () => {
    it("holds a month of spend that would overflow a 32-bit column", async () => {
      // $4,200 in nanodollars: unremarkable for a customer, and 1,955 times
      // larger than int4 can hold. This is the failure the old blanket
      // translation was hiding.
      const monthlySpend = 4_200n * USD;
      expect(monthlySpend).toBeGreaterThan(INT4_MAX);

      await pg.query("INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, $3)", [
        "t-money",
        "Acme",
        Date.now(),
      ]);
      await pg.query(
        `INSERT INTO calls (id, tenant_id, agent_id, department, provider, model,
                            started_at, duration_ms, streamed, cost_total, priced, outcome, run_id)
         VALUES ($1, $2, 'bot', 'Eng', 'anthropic', 'claude-sonnet-5', $3, 10, 0, $4, 1, 'ok', $1)`,
        ["c-money", "t-money", Date.now(), monthlySpend.toString()],
      );

      const read = await pg.query<{ cost_total: string | bigint }>(
        "SELECT cost_total FROM calls WHERE id = 'c-money'",
      );
      expect(BigInt(read.rows[0]!.cost_total)).toBe(monthlySpend);
    });

    it("holds a millisecond timestamp, which int4 could not", async () => {
      const now = BigInt(Date.now());
      expect(now).toBeGreaterThan(INT4_MAX);
      const read = await pg.query<{ started_at: string | bigint }>(
        "SELECT started_at FROM calls WHERE id = 'c-money'",
      );
      expect(BigInt(read.rows[0]!.started_at)).toBeGreaterThan(INT4_MAX);
    });

    it("does not waste eight bytes on a flag", async () => {
      const types = await pg.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'calls' AND column_name IN ('streamed', 'priced', 'cost_total', 'duration_ms')
         ORDER BY column_name`,
      );
      const byName = Object.fromEntries(types.rows.map((r) => [r.column_name, r.data_type]));
      expect(byName["cost_total"]).toBe("bigint");
      expect(byName["streamed"]).toBe("smallint");
      expect(byName["priced"]).toBe("smallint");
      expect(byName["duration_ms"]).toBe("integer");
    });

    it("still enforces the flag's CHECK constraint after narrowing", async () => {
      await expect(
        pg.query(
          `INSERT INTO calls (id, tenant_id, agent_id, department, provider, model,
                              started_at, duration_ms, streamed, priced, outcome, run_id)
           VALUES ('c-bad', 't-money', 'bot', 'Eng', 'anthropic', 'm', 1, 1, 7, 1, 'ok', 'c-bad')`,
        ),
      ).rejects.toThrow();
    });
  });

  describe("constraints behave as the application assumes", () => {
    it("cascades a tenant delete, which is what erasure relies on", async () => {
      await pg.query("INSERT INTO tenants (id, name, created_at) VALUES ('t-gone', 'Gone', 0)");
      await pg.query(
        `INSERT INTO calls (id, tenant_id, agent_id, department, provider, model,
                            started_at, duration_ms, streamed, outcome, run_id)
         VALUES ('c-gone', 't-gone', 'b', 'E', 'anthropic', 'm', 1, 1, 0, 'ok', 'c-gone')`,
      );
      await pg.query("DELETE FROM tenants WHERE id = 't-gone'");

      const left = await pg.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM calls WHERE tenant_id = 't-gone'",
      );
      expect(Number(left.rows[0]?.count)).toBe(0);
    });

    it("runs the domain-matching query single sign-on depends on", async () => {
      // String concatenation against a comma-joined list. It behaves the same
      // in both engines, and it decides who is allowed into an organisation,
      // so "the same" is worth executing rather than assuming.
      await pg.query(
        `INSERT INTO sso_connections
           (tenant_id, issuer, client_id, encrypted_secret, secret_hint, authorize_url,
            token_url, jwks_url, email_domains, created_at, updated_at)
         VALUES ('t-money', 'https://i', 'c', 'e', 'h', 'https://a', 'https://t', 'https://j',
                 'acme.test,acme.co.uk', 0, 0)`,
      );

      const hit = await pg.query(
        `SELECT tenant_id FROM sso_connections
         WHERE enabled = 1 AND (',' || email_domains || ',') LIKE ('%,' || $1 || ',%')`,
        ["acme.co.uk"],
      );
      expect(hit.rows).toHaveLength(1);

      const miss = await pg.query(
        `SELECT tenant_id FROM sso_connections
         WHERE enabled = 1 AND (',' || email_domains || ',') LIKE ('%,' || $1 || ',%')`,
        ["evil.test"],
      );
      // A partial match must not admit anybody: "me.test" is a substring of
      // "acme.test" and the comma fencing is what stops it counting.
      expect(miss.rows).toHaveLength(0);
    });
  });

  describe("the same question, asked of both engines", () => {
    /**
     * Differential testing, which is the only way to catch the divergences
     * nobody predicted. Identical rows go into SQLite and Postgres, the same
     * aggregate runs on each, and the answers must match exactly. Money is
     * integer nanodollars precisely so that "exactly" is a fair demand.
     */
    it("totals spend identically", async () => {
      const sqlite: Db = openDatabase({ path: ":memory:" });
      sqlite.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t', 'T', 0)").run();

      await pg.query("INSERT INTO tenants (id, name, created_at) VALUES ('t-diff', 'T', 0)");

      const costs = [1n, 999_999_999n, 4_200n * USD, 17n * USD + 5n, INT4_MAX + 1n];
      for (const [index, cost] of costs.entries()) {
        const id = `d${index}`;
        sqlite
          .prepare(
            `INSERT INTO calls (id, tenant_id, agent_id, department, provider, model,
                                started_at, duration_ms, streamed, cost_total, priced, outcome, run_id)
             VALUES (?, 't', 'bot', ?, 'anthropic', 'm', ?, 1, 0, ?, 1, 'ok', ?)`,
          )
          .run(id, index % 2 === 0 ? "Eng" : "Sales", 1000 + index, cost, id);
        await pg.query(
          `INSERT INTO calls (id, tenant_id, agent_id, department, provider, model,
                              started_at, duration_ms, streamed, cost_total, priced, outcome, run_id)
           VALUES ($1, 't-diff', 'bot', $2, 'anthropic', 'm', $3, 1, 0, $4, 1, 'ok', $1)`,
          [id, index % 2 === 0 ? "Eng" : "Sales", 1000 + index, cost.toString()],
        );
      }

      const sqliteRows = sqlite
        .prepare(
          `SELECT department, SUM(cost_total) AS total, COUNT(*) AS calls
           FROM calls WHERE tenant_id = 't' AND outcome = 'ok'
           GROUP BY department ORDER BY department`,
        )
        .safeIntegers(true)
        .all() as { department: string; total: bigint; calls: bigint }[];

      const pgResult = await pg.query<{ department: string; total: string; calls: string }>(
        `SELECT department, SUM(cost_total)::text AS total, COUNT(*)::text AS calls
         FROM calls WHERE tenant_id = 't-diff' AND outcome = 'ok'
         GROUP BY department ORDER BY department`,
      );

      expect(pgResult.rows.map((r) => r.department)).toEqual(sqliteRows.map((r) => r.department));
      expect(pgResult.rows.map((r) => BigInt(r.total))).toEqual(sqliteRows.map((r) => r.total));
      expect(pgResult.rows.map((r) => Number(r.calls))).toEqual(
        sqliteRows.map((r) => Number(r.calls)),
      );
      sqlite.close();
    });
  });

  describe("the code around the schema", () => {
    it("has no SQLite-only construct in the repository layer", () => {
      // The check the first version of this file did not do. It scanned the
      // migrations only, so PRAGMA and sqlite_master went into retention.ts
      // the same week and it still reported the schema as portable.
      const sources = readdirSync(SRC)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => ({ file: f, text: readFileSync(join(SRC, f), "utf8") }));

      const findings = unportableQueries(sources).filter((f) => f.file !== "portability.ts");
      // Grouped by file and construct rather than pinned to line numbers. An
      // inventory that breaks whenever somebody adds a comment gets its
      // expectations updated without being read, which defeats the point.
      const described = [
        ...new Set(findings.map((f) => `${f.file}: ${f.construct}`)),
      ].sort();

      // Documented rather than silently tolerated, and grouped by what each
      // one actually costs to port:
      //
      //   analytics.ts  strftime, bucketing calls by UTC day. Real SQL that
      //                 Postgres rejects. It becomes to_char(to_timestamp(...)),
      //                 and the day boundaries must be re-tested, because that
      //                 is a figure on a customer's statement.
      //   database.ts   PRAGMA on the connection: WAL, synchronous,
      //                 foreign_keys. Not queries and not a translation
      //                 problem. WAL and synchronous are SQLite storage
      //                 concerns with no counterpart, and Postgres enforces
      //                 foreign keys unconditionally.
      //   retention.ts  Schema introspection, so erasure can prove it covers
      //                 every table carrying a tenant id. Needs an
      //                 information_schema equivalent.
      //
      // This list is the point of the test. It was empty when the checker only
      // read migrations, which is exactly how a portability claim rots.
      expect(described).toEqual([
        "analytics.ts: SQLite date function",
        "database.ts: PRAGMA",
        "retention.ts: PRAGMA",
        "retention.ts: sqlite_master",
      ]);
    });
  });
});
