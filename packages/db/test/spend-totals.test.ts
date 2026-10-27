import { priceUsage, ZERO_USAGE } from "@costgrid/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/database.js";
import { CostGridRepository } from "../src/repositories.js";
import { Retention } from "../src/retention.js";
import { MIGRATIONS } from "../src/schema.js";

/**
 * Budgets read spend from running totals instead of summing every call. These
 * tests hold them to the figure the sum over `calls` gives, which is what
 * budgets read before.
 */

const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);
const DAY = 86_400_000;

function sumFromCalls(db: Database.Database, tenant: string, from: number, where = "", params: unknown[] = []): bigint {
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_total), 0) AS total FROM calls WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ?${where}`)
    .safeIntegers(true)
    .get(tenant, from, ...params) as { total: bigint };
  return row.total;
}

describe("spend running totals", () => {
  let db: Database.Database;
  let repository: CostGridRepository;
  let n = 0;

  const record = (agent: string, department: string, at: number, outcome: "ok" | "error" | "blocked" = "ok", model = "claude-sonnet-4-5") => {
    const usage = { ...ZERO_USAGE, inputTokens: 1_000 + n * 7, outputTokens: 300 + n };
    const priced = priceUsage(model, usage);
    repository.recordCall({
      id: `c${n++}`,
      tenantId: "t1",
      agentId: agent,
      department,
      provider: "anthropic",
      model,
      startedAt: at,
      durationMs: 5,
      streamed: false,
      usage,
      cost: priced.cost,
      priced: priced.priced,
      outcome,
    });
  };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    n = 0;
  });
  afterEach(() => db.close());

  it("give the same day and month figures as summing the calls, for every scope", () => {
    const monthStart = Date.UTC(2026, 9, 1);
    const dayStart = Date.UTC(2026, 9, 27);
    // Last month, earlier this month, just before and after midnight, today,
    // and calls that did not go through and must not count.
    for (const at of [monthStart - 1, monthStart, dayStart - 1, dayStart, NOW - 1000, NOW]) {
      record("a", "Eng", at);
      record("b", "Eng", at);
      record("c", "Sales", at);
    }
    record("a", "Eng", NOW, "error");
    record("a", "Eng", NOW, "blocked");

    const cases = [
      { scope: { kind: "tenant" } as const, where: "", params: [] },
      { scope: { kind: "agent", agentId: "a" } as const, where: " AND agent_id = ?", params: ["a"] },
      { scope: { kind: "department", department: "Eng" } as const, where: " AND department = ?", params: ["Eng"] },
    ];
    for (const { scope, where, params } of cases) {
      const snapshot = repository.spendFor("t1", scope, NOW);
      expect(snapshot.day, scope.kind).toBe(sumFromCalls(db, "t1", dayStart, where, params));
      expect(snapshot.month, scope.kind).toBe(sumFromCalls(db, "t1", monthStart, where, params));
      expect(snapshot.month > snapshot.day).toBe(true);
    }
  });

  it("are filled from the calls already recorded when the migration runs", () => {
    const old = new Database(":memory:");
    old.pragma("foreign_keys = ON");
    old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;");
    const mark = old.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)");
    for (const m of MIGRATIONS.filter((m) => m.version < 20)) {
      old.exec(m.sql);
      mark.run(m.version, m.name, 0);
    }
    old.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    const insert = old.prepare(
      `INSERT INTO calls (id, tenant_id, agent_id, department, provider, model, started_at, duration_ms, streamed,
         input_tokens, output_tokens, cost_total, priced, outcome, run_id)
       VALUES (?, 't1', ?, 'Eng', 'anthropic', 'm', ?, 1, 0, 0, 0, ?, 1, ?, ?)`,
    );
    insert.run("x1", "a", NOW - 2 * DAY, 1_000_000_000, "ok", "x1");
    insert.run("x2", "a", NOW, 2_500_000_000, "ok", "x2");
    insert.run("x3", "a", NOW, 9_000_000_000, "error", "x3");

    migrate(old);
    const snapshot = new CostGridRepository(old).spendFor("t1", { kind: "agent", agentId: "a" }, NOW);
    expect(snapshot.day).toBe(2_500_000_000n);
    expect(snapshot.month).toBe(3_500_000_000n);
    old.close();
  });

  it("are not forgotten inside the current month when call detail is purged early", () => {
    record("a", "Eng", Date.UTC(2026, 9, 2));
    record("a", "Eng", Date.UTC(2026, 7, 2));
    const before = repository.spendFor("t1", { kind: "tenant" }, NOW).month;

    const retention = new Retention(db);
    retention.set("t1", { callDays: 7 });
    retention.purge("t1", NOW);

    expect(repository.spendFor("t1", { kind: "tenant" }, NOW).month).toBe(before);
    const kept = db.prepare("SELECT COUNT(*) AS n FROM spend_daily WHERE day_start < ?").get(Date.UTC(2026, 9, 1)) as { n: number };
    expect(kept.n).toBe(0);
  });

  it("go with the organisation when it is erased", () => {
    record("a", "Eng", NOW);
    new Retention(db).eraseTenant("t1", NOW);
    const left = db.prepare("SELECT COUNT(*) AS n FROM spend_daily").get() as { n: number };
    expect(left.n).toBe(0);
  });
});
