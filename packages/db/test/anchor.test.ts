import { beforeEach, describe, expect, it } from "vitest";
import {
  Anchors,
  ANCHOR_GENESIS,
  AuditLog,
  compareToAnchors,
  generateAnchorKeys,
  openDatabase,
  verifyAnchor,
  type Anchor,
  type Db,
} from "../src/index.js";

/**
 * Anchoring exists so that tampering cannot be quiet. These tests do the
 * tampering and check that it makes a noise.
 */
describe("anchoring the audit log", () => {
  let db: Db;
  let anchors: Anchors;
  let audit: AuditLog;
  let keys: { privateKey: string; publicKey: string };

  const ALICE = { kind: "user", id: "u1", label: "alice@acme.test" } as const;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    anchors = new Anchors(db);
    audit = new AuditLog(db);
    keys = generateAnchorKeys();
  });

  const record = (n: number): void => {
    for (let i = 0; i < n; i++) {
      audit.record("t1", { actor: ALICE, action: "apikey.created", subject: `k${i}` });
    }
  };

  it("signs an anchor the receiver can verify with only the public key", () => {
    record(5);
    const anchor = anchors.create("t1", keys.privateKey);

    expect(anchor.payload.auditSeq).toBe(5);
    expect(anchor.payload.auditHash).toBe(audit.head("t1").hash);
    expect(verifyAnchor(anchor, keys.publicKey)).toBe(true);
  });

  it("refuses an anchor signed by a different key", () => {
    record(3);
    const anchor = anchors.create("t1", keys.privateKey);
    // The receiver holds only the public half, so an anchor is evidence
    // against the host rather than something either side could have written.
    expect(verifyAnchor(anchor, generateAnchorKeys().publicKey)).toBe(false);
  });

  it("refuses an anchor whose contents were altered after signing", () => {
    record(9);
    const anchor = anchors.create("t1", keys.privateKey);
    const forged: Anchor = {
      ...anchor,
      payload: { ...anchor.payload, auditSeq: 3 },
    };
    expect(verifyAnchor(forged, keys.publicKey)).toBe(false);
  });

  it("chains anchors to each other, so the stream cannot be thinned out", () => {
    record(2);
    const first = anchors.create("t1", keys.privateKey);
    record(2);
    const second = anchors.create("t1", keys.privateKey);

    expect(first.payload.prevAnchor).toBe(ANCHOR_GENESIS);
    expect(second.payload.prevAnchor).toBe(first.hash);
    expect(second.payload.anchorNo).toBe(2);
  });

  it("anchors even when nothing happened, so silence means something", () => {
    record(4);
    anchors.create("t1", keys.privateKey);
    const heartbeat = anchors.create("t1", keys.privateKey);

    // Same head, new anchor number. Without this a receiver could not tell a
    // quiet week from a sender somebody switched off.
    expect(heartbeat.payload.auditSeq).toBe(4);
    expect(heartbeat.payload.anchorNo).toBe(2);
  });

  describe("catching what the local chain cannot", () => {
    const held = (): Anchor[] => anchors.recent("t1", 50).map((r) => ({
      payload: r.payload,
      signature: r.signature,
      hash: r.hash,
    }));
    const compare = (archive: Anchor[]) =>
      compareToAnchors(archive, audit.head("t1"), (seq) => audit.hashAt("t1", seq));

    it("says nothing when nothing was touched", () => {
      record(6);
      anchors.create("t1", keys.privateKey);
      expect(compare(held())).toEqual([]);
    });

    it("catches entries deleted from the end", () => {
      record(10);
      const archive = held().concat(
        (anchors.create("t1", keys.privateKey), held()),
      );
      const snapshot = held();

      // The deletion the hash chain alone cannot see: what is removed links to
      // nothing, so the survivors still verify perfectly.
      db.prepare("DELETE FROM audit_log WHERE tenant_id = 't1' AND seq > 6").run();
      expect(audit.verify("t1").intact).toBe(true);

      const found = compareToAnchors(snapshot, audit.head("t1"), (s) => audit.hashAt("t1", s));
      expect(found.map((d) => d.kind)).toContain("head-regressed");
      expect(found[0]?.detail).toContain("4 were deleted");
      expect(archive.length).toBeGreaterThan(0);
    });

    it("catches an entry edited and the chain recomputed around it", () => {
      record(5);
      anchors.create("t1", keys.privateKey);
      const snapshot = held();

      // A thorough attacker does not leave a broken chain. They rewrite the
      // entry and every hash after it, so local verification passes.
      const rebuilt = new AuditLog(db);
      db.prepare("DELETE FROM audit_log WHERE tenant_id = 't1'").run();
      for (let i = 0; i < 5; i++) {
        rebuilt.record("t1", {
          actor: i === 2 ? { kind: "user", id: "u9", label: "someone.else@acme.test" } : ALICE,
          action: "apikey.created",
          subject: `k${i}`,
        });
      }
      expect(audit.verify("t1").intact).toBe(true);

      const found = compareToAnchors(snapshot, audit.head("t1"), (s) => audit.hashAt("t1", s));
      expect(found.map((d) => d.kind)).toContain("head-disagrees");
    });

    it("catches an anchor removed from the archive", () => {
      record(2);
      anchors.create("t1", keys.privateKey);
      record(2);
      anchors.create("t1", keys.privateKey);
      record(2);
      anchors.create("t1", keys.privateKey);

      const thinned = held().filter((a) => a.payload.anchorNo !== 2);
      const found = compareToAnchors(thinned, audit.head("t1"), (s) => audit.hashAt("t1", s));
      expect(found.map((d) => d.kind)).toContain("gap-in-stream");
    });
  });

  describe("delivery", () => {
    it("keeps an anchor until the receiver accepts it", () => {
      record(1);
      anchors.create("t1", keys.privateKey);
      expect(anchors.undelivered("t1")).toHaveLength(1);

      anchors.markDelivered("t1", 1);
      expect(anchors.undelivered("t1")).toHaveLength(0);
    });

    it("remembers why delivery failed, and counts the tries", () => {
      record(1);
      anchors.create("t1", keys.privateKey);
      anchors.markFailed("t1", 1, "connect ECONNREFUSED 10.0.0.9:443");
      anchors.markFailed("t1", 1, "connect ECONNREFUSED 10.0.0.9:443");

      const [pending] = anchors.undelivered("t1");
      expect(pending?.attempts).toBe(2);
      expect(pending?.lastError).toContain("ECONNREFUSED");
      // An anchor nobody received is the interesting one, so it stays visible
      // rather than being dropped after a few tries.
      expect(pending?.deliveredAt).toBeUndefined();
    });
  });
});
