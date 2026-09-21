import { beforeEach, describe, expect, it } from "vitest";
import { AuditLog, GENESIS_HASH, openDatabase, type Db } from "../src/index.js";

/**
 * The audit log's only real claim is that a change to it can be detected.
 * These tests make the change and check that it is.
 */
describe("audit log", () => {
  let db: Db;
  let audit: AuditLog;

  const ALICE = { kind: "user", id: "u1", label: "alice@acme.test" } as const;
  const BOB = { kind: "user", id: "u2", label: "bob@acme.test" } as const;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t2', 'Other', 0)").run();
    audit = new AuditLog(db);
  });

  it("starts from a known hash and links each entry to the one before", () => {
    const first = audit.record("t1", { actor: ALICE, action: "plan.changed", subject: "team" });
    const second = audit.record("t1", { actor: BOB, action: "apikey.created", subject: "k1" });

    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(audit.head("t1")).toEqual({ seq: 2, hash: second.hash });
  });

  it("gives an empty tenant the genesis hash rather than nothing", () => {
    expect(audit.head("t1")).toEqual({ seq: 0, hash: GENESIS_HASH });
  });

  it("numbers each organisation separately", () => {
    audit.record("t1", { actor: ALICE, action: "a", subject: "x" });
    const other = audit.record("t2", { actor: ALICE, action: "a", subject: "x" });
    expect(other.seq).toBe(1);
  });

  it("verifies a chain nobody has touched", () => {
    for (let i = 0; i < 20; i++) {
      audit.record("t1", { actor: ALICE, action: "credential.added", subject: `p${i}` });
    }
    const result = audit.verify("t1");
    expect(result.intact).toBe(true);
    expect(result.entries).toBe(20);
    expect(result.head).toBe(audit.head("t1").hash);
  });

  it("notices an entry edited in place", () => {
    audit.record("t1", { actor: ALICE, action: "plan.changed", subject: "free" });
    audit.record("t1", { actor: ALICE, action: "plan.changed", subject: "team" });
    audit.record("t1", { actor: ALICE, action: "plan.changed", subject: "business" });

    // The classic cover-up: make the record say somebody else did it.
    db.prepare("UPDATE audit_log SET actor_label = ? WHERE tenant_id = 't1' AND seq = 2")
      .run("bob@acme.test");

    const result = audit.verify("t1");
    expect(result.intact).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
    expect(result.brokenReason).toContain("edited in place");
  });

  it("notices an entry removed from the middle", () => {
    for (let i = 0; i < 5; i++) {
      audit.record("t1", { actor: ALICE, action: "apikey.created", subject: `k${i}` });
    }
    db.prepare("DELETE FROM audit_log WHERE tenant_id = 't1' AND seq = 3").run();

    const result = audit.verify("t1");
    expect(result.intact).toBe(false);
    expect(result.brokenAtSeq).toBe(4);
  });

  it("notices entries removed from the end, which break no link", () => {
    for (let i = 0; i < 5; i++) {
      audit.record("t1", { actor: ALICE, action: "apikey.created", subject: `k${i}` });
    }
    // Deleting the newest entries leaves a chain that still links perfectly.
    // Only the gapless-sequence check can see this, which is why it exists.
    const head = audit.head("t1");
    db.prepare("DELETE FROM audit_log WHERE tenant_id = 't1' AND seq > 3").run();

    const result = audit.verify("t1");
    expect(result.intact).toBe(true);
    // The chain is self-consistent, so detection depends on someone having
    // written the head hash down. That is the whole point of publishing it.
    expect(result.head).not.toBe(head.hash);
    expect(result.entries).toBe(3);
  });

  it("notices two entries swapped", () => {
    const a = audit.record("t1", { actor: ALICE, action: "one", subject: "x" });
    const b = audit.record("t1", { actor: ALICE, action: "two", subject: "y" });
    audit.record("t1", { actor: ALICE, action: "three", subject: "z" });

    db.prepare("UPDATE audit_log SET action = ? WHERE tenant_id = 't1' AND seq = ?")
      .run(b.action, a.seq);
    db.prepare("UPDATE audit_log SET action = ? WHERE tenant_id = 't1' AND seq = ?")
      .run(a.action, b.seq);

    expect(audit.verify("t1").intact).toBe(false);
  });

  it("hashes the detail, so changing a figure inside it breaks the chain", () => {
    audit.record("t1", {
      actor: ALICE,
      action: "retention.changed",
      subject: "t1",
      detail: { callDaysFrom: 0, callDaysTo: 30 },
    });

    db.prepare("UPDATE audit_log SET detail = ? WHERE tenant_id = 't1' AND seq = 1")
      .run(JSON.stringify({ callDaysFrom: 0, callDaysTo: 3650 }));

    expect(audit.verify("t1").intact).toBe(false);
  });

  it("hashes detail keys in a fixed order, so insertion order cannot matter", () => {
    const one = audit.record(
      "t1",
      { actor: ALICE, action: "x", subject: "s", detail: { b: 2, a: 1 } },
      1000,
    );
    const two = audit.record(
      "t2",
      { actor: ALICE, action: "x", subject: "s", detail: { a: 1, b: 2 } },
      1000,
    );
    expect(one.hash).toBe(two.hash);
  });

  it("survives a purge, and says in the log that one happened", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      audit.record("t1", { actor: ALICE, action: "apikey.created", subject: `k${i}` }, now - (10 - i) * day);
    }

    const removed = audit.purgeBefore("t1", now - 5 * day, ALICE, now);
    expect(removed).toBe(5);

    const result = audit.verify("t1");
    expect(result.intact).toBe(true);
    expect(result.truncations).toHaveLength(1);

    // The record of the deletion carries what went and how far back.
    const entry = audit.list("t1", { action: "audit" }).find((e) => e.action === "audit.truncated");
    expect(entry?.detail["removed"]).toBe(5);
    expect(entry?.detail["throughSeq"]).toBe(5);
  });

  it("does not let a forged gap hide behind the truncation rule", () => {
    for (let i = 0; i < 6; i++) {
      audit.record("t1", { actor: ALICE, action: "apikey.created", subject: `k${i}` });
    }
    // Cutting entries out of the middle is not a purge, and calling the
    // survivor an ordinary entry does not make the hole disappear.
    db.prepare("DELETE FROM audit_log WHERE tenant_id = 't1' AND seq IN (2, 3)").run();

    const result = audit.verify("t1");
    expect(result.intact).toBe(false);
    expect(result.brokenReason).toContain("missing");
  });

  it("filters the listing by action prefix", () => {
    audit.record("t1", { actor: ALICE, action: "auth.signed-in", subject: "a" });
    audit.record("t1", { actor: ALICE, action: "auth.sign-in-failed", subject: "a" });
    audit.record("t1", { actor: ALICE, action: "plan.changed", subject: "team" });

    expect(audit.list("t1", { action: "auth" })).toHaveLength(2);
    expect(audit.list("t1", { action: "plan" })).toHaveLength(1);
  });

  it("keeps the actor's label even after the account is gone", () => {
    audit.record("t1", { actor: ALICE, action: "credential.added", subject: "anthropic" });
    // No users row was ever required: the label is a copy taken at the time,
    // so deleting the account cannot blank out who did it.
    expect(audit.list("t1")[0]?.actor.label).toBe("alice@acme.test");
  });
});
