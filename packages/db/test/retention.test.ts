import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  type Db,
  MIN_AUDIT_DAYS,
  openDatabase,
  Retention,
} from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;
const OWNER = { kind: "user", id: "u1", label: "owner@acme.test" } as const;

describe("retention", () => {
  let db: Db;
  let retention: Retention;
  let audit: AuditLog;
  let now: number;

  /** One metered call, `ageDays` old, with the rows that hang off it. */
  function seedCall(tenantId: string, ageDays: number): string {
    const id = randomUUID();
    const at = now - ageDays * DAY;
    db.prepare(
      `INSERT INTO calls (id, tenant_id, agent_id, department, provider, model,
                          started_at, duration_ms, streamed, cost_total, priced, outcome, run_id)
       VALUES (?, ?, 'bot', 'Eng', 'anthropic', 'claude-sonnet-4-5', ?, 10, 0, 100, 1, 'ok', ?)`,
    ).run(id, tenantId, at, id);
    db.prepare(
      `INSERT INTO tool_invocations (id, tenant_id, call_id, run_id, agent_id, tool_name, occurred_at)
       VALUES (?, ?, ?, ?, 'bot', 'search', ?)`,
    ).run(randomUUID(), tenantId, id, id, at);
    db.prepare(
      "INSERT INTO outcomes (tenant_id, run_id, succeeded, reported_at) VALUES (?, ?, 1, ?)",
    ).run(tenantId, id, at);
    db.prepare(
      `INSERT INTO violations (id, tenant_id, call_id, policy_id, policy_name, action, reason, occurred_at)
       VALUES (?, ?, ?, 'p1', 'Eng budget', 'warn', 'over', ?)`,
    ).run(randomUUID(), tenantId, id, at);
    return id;
  }

  beforeEach(() => {
    now = Date.UTC(2026, 8, 21);
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    retention = new Retention(db);
    audit = new AuditLog(db);
  });

  it("keeps everything when nobody has set a policy", () => {
    seedCall("t1", 400);
    expect(retention.settingsOf("t1").callDays).toBe(0);
    expect(retention.purge("t1", now).total).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 1 });
  });

  it("removes call detail past the window and leaves the rest", () => {
    seedCall("t1", 100);
    const recent = seedCall("t1", 5);
    retention.set("t1", { callDays: 30 }, OWNER, now);

    const result = retention.purge("t1", now);
    expect(result.calls).toBe(1);
    expect(result.toolInvocations).toBe(1);
    expect(result.outcomes).toBe(1);
    // The enforcement window was never set, so nothing there was touched.
    expect(result.violations).toBe(0);

    const kept = db.prepare("SELECT id FROM calls").all() as { id: string }[];
    expect(kept.map((r) => r.id)).toEqual([recent]);
  });

  it("keeps enforcement history on its own clock", () => {
    seedCall("t1", 100);
    retention.set("t1", { eventDays: 30 }, OWNER, now);

    const result = retention.purge("t1", now);
    expect(result.violations).toBe(1);
    // Enforcement history can be shorter or longer than call detail. Here the
    // calls have no window at all and must survive.
    expect(result.calls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 1 });
  });

  it("purges imported history by the day it was bucketed under", () => {
    db.prepare(
      `INSERT INTO imported_usage (id, tenant_id, provider, day, model, imported_at)
       VALUES (?, 't1', 'anthropic', ?, 'claude-sonnet-4-5', ?)`,
    ).run(randomUUID(), new Date(now - 100 * DAY).toISOString().slice(0, 10), now);
    db.prepare(
      `INSERT INTO imported_usage (id, tenant_id, provider, day, model, imported_at)
       VALUES (?, 't1', 'anthropic', ?, 'claude-sonnet-4-5', ?)`,
    ).run(randomUUID(), new Date(now - 2 * DAY).toISOString().slice(0, 10), now);

    retention.set("t1", { callDays: 30 }, OWNER, now);
    expect(retention.purge("t1", now).importedUsage).toBe(1);
  });

  it("is safe to run twice", () => {
    seedCall("t1", 100);
    retention.set("t1", { callDays: 30 }, OWNER, now);
    expect(retention.purge("t1", now).total).toBeGreaterThan(0);
    expect(retention.purge("t1", now).total).toBe(0);
  });

  it("records the policy change and the deletion, and who did each", () => {
    seedCall("t1", 100);
    retention.set("t1", { callDays: 30 }, OWNER, now);
    retention.purge("t1", now);

    const entries = audit.list("t1", { action: "retention" });
    const actions = entries.map((e) => e.action).sort();
    expect(actions).toEqual(["retention.changed", "retention.purged"]);

    const changed = entries.find((e) => e.action === "retention.changed");
    expect(changed?.actor.label).toBe("owner@acme.test");
    expect(changed?.detail["callDaysFrom"]).toBe(0);
    expect(changed?.detail["callDaysTo"]).toBe(30);

    // The scheduled deletion had no person behind it, and says so.
    expect(entries.find((e) => e.action === "retention.purged")?.actor.kind).toBe("system");
    expect(audit.verify("t1").intact).toBe(true);
  });

  it("writes no audit entry for a run that deleted nothing", () => {
    retention.set("t1", { callDays: 30 }, OWNER, now);
    retention.purge("t1", now);
    // A daily job logging "removed 0 rows" every day would bury the entries
    // that matter under three hundred that do not.
    expect(audit.list("t1", { action: "retention.purged" })).toHaveLength(0);
  });

  it("refuses an audit window short enough to be a cover-up", () => {
    expect(() => retention.set("t1", { auditDays: 30 }, OWNER, now)).toThrow(/at least 365/);
    expect(() => retention.set("t1", { auditDays: MIN_AUDIT_DAYS }, OWNER, now)).not.toThrow();
    // Zero still means keep forever, which is the safe end of the range.
    expect(() => retention.set("t1", { auditDays: 0 }, OWNER, now)).not.toThrow();
  });

  it("refuses a window that is not a whole number of days", () => {
    expect(() => retention.set("t1", { callDays: -1 }, OWNER, now)).toThrow();
    expect(() => retention.set("t1", { callDays: 1.5 }, OWNER, now)).toThrow();
  });

  it("never touches the audit log on a scheduled purge", () => {
    seedCall("t1", 800);
    retention.set("t1", { callDays: 30, auditDays: MIN_AUDIT_DAYS }, OWNER, now);
    const before = audit.list("t1").length;
    retention.purge("t1", now);
    // Evidence is only removed by a person running a command, never by a timer.
    expect(audit.list("t1").length).toBeGreaterThanOrEqual(before);
    expect(audit.verify("t1").truncations).toHaveLength(0);
  });

  it("purges every tenant that has a policy, and only those", () => {
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t2', 'Other', 0)").run();
    seedCall("t1", 100);
    seedCall("t2", 100);
    retention.set("t1", { callDays: 30 }, OWNER, now);

    const results = retention.purgeAll(now);
    expect([...results.keys()]).toEqual(["t1"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE tenant_id = 't2'").get()).toEqual({
      n: 1,
    });
  });

  describe("erasure", () => {
    it("removes everything belonging to one organisation and nothing else", () => {
      db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t2', 'Other', 0)").run();
      seedCall("t1", 1);
      seedCall("t2", 1);
      audit.record("t1", { actor: OWNER, action: "plan.changed", subject: "team" });

      const result = retention.eraseTenant("t1", now);
      expect(result.total).toBeGreaterThan(0);
      expect(result.tables["calls"]).toBe(1);
      expect(result.tables["audit_log"]).toBe(1);

      expect(db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE id = 't1'").get()).toEqual({
        n: 0,
      });
    });

    it("covers every table that carries a tenant id", () => {
      // Erasure is only as complete as its list, and a list kept by hand goes
      // stale the first time somebody adds a table. Failing here means the new
      // table needs adding to TENANT_TABLES, not that this test needs relaxing.
      expect(retention.tablesMissingFromErasure()).toEqual([]);
    });
  });
});
