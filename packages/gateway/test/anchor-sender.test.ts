import {
  Anchors,
  AuditLog,
  generateAnchorKeys,
  openDatabase,
  verifyAnchor,
  type Anchor,
  type Db,
} from "@costgrid/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnchorSender } from "../src/anchor-sender.js";

/**
 * The sender, against a receiver that behaves like a real one: sometimes down.
 */
describe("sending anchors", () => {
  let db: Db;
  let anchors: Anchors;
  let keys: { privateKey: string; publicKey: string };
  let received: Anchor[];
  let receiverStatus: number;

  const log = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  } as unknown as Parameters<typeof AnchorSender.prototype.run> extends never ? never : any;

  const receiver = (async (_url: unknown, init?: RequestInit) => {
    if (receiverStatus !== 200) return new Response("no", { status: receiverStatus });
    received.push(JSON.parse(String(init?.body)) as Anchor);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const sender = (): AnchorSender =>
    new AnchorSender(anchors, {
      url: "https://siem.example.test/costgrid",
      privateKey: keys.privateKey,
      fetchImpl: receiver,
      log,
    });

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1', 'Acme', 0)").run();
    new AuditLog(db).record("t1", {
      actor: { kind: "user", id: "u1", label: "a@acme.test" },
      action: "apikey.created",
      subject: "k1",
    });
    anchors = new Anchors(db);
    keys = generateAnchorKeys();
    received = [];
    receiverStatus = 200;
  });

  it("delivers an anchor the receiver can verify on its own", async () => {
    const result = await sender().run();

    expect(result).toMatchObject({ created: 1, delivered: 1, failed: 0 });
    expect(received).toHaveLength(1);
    // The receiver holds only the public key and can still prove the anchor
    // came from this CostGrid unaltered. That is what makes it evidence.
    expect(verifyAnchor(received[0]!, keys.publicKey)).toBe(true);
  });

  it("keeps an anchor and retries it when the receiver is down", async () => {
    receiverStatus = 503;
    const first = await sender().run();
    expect(first).toMatchObject({ delivered: 0, failed: 1 });
    expect(anchors.undelivered("t1")).toHaveLength(1);

    // The sequence number was reserved while the receiver was unreachable, so
    // the archive ends up complete rather than with a hole where the outage was.
    receiverStatus = 200;
    await sender().run();
    expect(received.map((a) => a.payload.anchorNo)).toEqual([1, 2]);
    expect(anchors.undelivered("t1")).toHaveLength(0);
  });

  it("anchors even when the audit log has not moved", async () => {
    await sender().run();
    await sender().run();

    expect(received).toHaveLength(2);
    expect(received[0]!.payload.auditSeq).toBe(received[1]!.payload.auditSeq);
    // Identical head, different anchor number. Without a heartbeat a receiver
    // cannot tell a quiet week from somebody switching the sender off, and
    // switching it off is the first thing you would do before tampering.
    expect(received[1]!.payload.anchorNo).toBe(2);
  });

  it("produces a stream a receiver can check for gaps", async () => {
    for (let i = 0; i < 4; i++) await sender().run();

    expect(received.map((a) => a.payload.anchorNo)).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < received.length; i++) {
      // Each anchor names the one before it, so removing a middle anchor from
      // the archive leaves the survivors disagreeing with each other.
      expect(received[i]!.payload.prevAnchor).toBe(received[i - 1]!.hash);
    }
  });

  it("does not spend the run hammering a receiver that is refusing", async () => {
    receiverStatus = 503;
    await sender().run();
    await sender().run();
    await sender().run();

    // Three anchors are now pending. A run should try one and stop, not work
    // through the whole backlog against a receiver that is plainly down.
    const pending = anchors.undelivered("t1", 100);
    expect(pending).toHaveLength(3);
    expect(pending[0]!.attempts).toBe(3);
    expect(pending[2]!.attempts).toBe(0);
  });
});
