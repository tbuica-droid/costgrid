import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { AuditLog } from "./audit.js";
import type { Db } from "./database.js";

/**
 * Putting the audit log's fingerprint somewhere CostGrid cannot reach.
 *
 * ## The problem this fixes
 *
 * A hash chain proves nothing on its own. It proves something to whoever holds
 * an older copy of the head, because they can see the head no longer follows
 * from it. Until now the only way anybody held an older copy was
 * `costgrid audit head` telling an administrator to write one down, which
 * makes the entire guarantee depend on the diligence of the person an audit is
 * most likely to be investigating.
 *
 * An anchor is that fingerprint, signed and sent on a schedule to a system the
 * operator controls separately: a SIEM, a log collector, an auditor's
 * endpoint, a bucket with object lock.
 *
 * ## What this does and does not buy
 *
 * Worth being exact, because the temptation is to describe it as making the
 * log immutable, and it does not.
 *
 * Whoever controls the host controls the sender and the signing key. They can
 * stop anchoring, and they can sign a false anchor. **What they cannot do is
 * reach into the receiver and change an anchor already delivered.** So:
 *
 * - Editing an old entry changes the head, which no longer matches the anchor
 *   the receiver already holds for that sequence. Caught.
 * - Deleting recent entries moves the head backwards. The next anchor covers a
 *   lower sequence than one already delivered. Caught.
 * - Turning anchoring off to avoid both produces a stream that stops. The
 *   receiver sees silence where it expected a heartbeat. Caught, provided
 *   somebody alarms on absence, which is why anchors carry their own sequence
 *   and a heartbeat is sent even when nothing has changed.
 *
 * The property is not "cannot be tampered with". It is "cannot be tampered
 * with quietly", and that is the honest claim.
 *
 * ## Why Ed25519 rather than a shared secret
 *
 * An HMAC would let the receiver verify an anchor, and also forge one, because
 * verifying and signing use the same key. With a signature the receiver holds
 * only the public key, so an anchor in their archive is evidence against the
 * host rather than something either party could have written. That matters
 * precisely when the two disagree, which is the only time any of this is used.
 */

/** The signed content of an anchor. Serialised exactly as written here. */
export interface AnchorPayload {
  readonly v: 1;
  readonly tenant: string;
  /** Position in the anchor stream. A gap is the signal to alarm on. */
  readonly anchorNo: number;
  /** The audit entry count this anchor commits to. */
  readonly auditSeq: number;
  /** The audit chain head. */
  readonly auditHash: string;
  /** The previous anchor's own hash, so the stream is itself a chain. */
  readonly prevAnchor: string;
  readonly at: string;
}

export interface Anchor {
  readonly payload: AnchorPayload;
  /** Base64 Ed25519 signature over the canonical payload bytes. */
  readonly signature: string;
  /** SHA-256 of the canonical payload, used as the next anchor's prevAnchor. */
  readonly hash: string;
}

export interface AnchorRecord extends Anchor {
  readonly createdAt: number;
  readonly deliveredAt: number | undefined;
  readonly attempts: number;
  readonly lastError: string | undefined;
}

/** Chain start for the anchor stream, distinct from the audit log's genesis. */
export const ANCHOR_GENESIS = "0".repeat(64);

/**
 * Canonical bytes.
 *
 * Field order is fixed and part of the format: a receiver that re-serialises
 * differently would compute a different hash and reject a genuine anchor.
 */
export function canonicalPayload(payload: AnchorPayload): string {
  return JSON.stringify([
    payload.v,
    payload.tenant,
    payload.anchorNo,
    payload.auditSeq,
    payload.auditHash,
    payload.prevAnchor,
    payload.at,
  ]);
}

function payloadHash(payload: AnchorPayload): string {
  return createHash("sha256").update(canonicalPayload(payload)).digest("hex");
}

/** Generate a signing key. The private half stays on the host; the public half goes to the receiver. */
export function generateAnchorKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/**
 * Check an anchor against the public key.
 *
 * Exported because the useful place to run it is the receiver, not here. A
 * verification that only the sender can perform is not much of a check.
 */
export function verifyAnchor(anchor: Anchor, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    const ok = verify(
      null,
      Buffer.from(canonicalPayload(anchor.payload), "utf8"),
      key,
      Buffer.from(anchor.signature, "base64"),
    );
    return ok && payloadHash(anchor.payload) === anchor.hash;
  } catch {
    return false;
  }
}

export type DivergenceKind = "head-regressed" | "head-disagrees" | "gap-in-stream";

export interface Divergence {
  readonly kind: DivergenceKind;
  readonly anchorNo: number;
  readonly detail: string;
}

/**
 * Compare anchors a receiver holds against what this database says now.
 *
 * This is the whole point of anchoring, and it runs against anchors fetched
 * back from the receiver rather than the local copies, which an attacker on
 * this host could have rewritten alongside everything else.
 */
export function compareToAnchors(
  held: readonly Anchor[],
  current: { seq: number; hash: string },
  historicalHashAt: (seq: number) => string | undefined,
): Divergence[] {
  const divergences: Divergence[] = [];
  const ordered = [...held].sort((a, b) => a.payload.anchorNo - b.payload.anchorNo);

  let expectedNo: number | undefined;
  for (const anchor of ordered) {
    const { anchorNo, auditSeq, auditHash } = anchor.payload;

    if (expectedNo !== undefined && anchorNo !== expectedNo) {
      divergences.push({
        kind: "gap-in-stream",
        anchorNo,
        detail:
          `anchor ${expectedNo} is missing from the archive. Either it was never sent, ` +
          "which means anchoring was off, or it was removed.",
      });
    }
    expectedNo = anchorNo + 1;

    // The log has fewer entries than something already committed to. Entries
    // were removed from the end, which no hash link can reveal on its own.
    if (auditSeq > current.seq) {
      divergences.push({
        kind: "head-regressed",
        anchorNo,
        detail:
          `anchor ${anchorNo} committed to ${auditSeq} entries, and the log now holds ` +
          `${current.seq}. At least ${auditSeq - current.seq} were deleted.`,
      });
      continue;
    }

    // The log still reaches that sequence, but says something different
    // happened there. An entry was edited.
    const now = historicalHashAt(auditSeq);
    if (now !== undefined && now !== auditHash) {
      divergences.push({
        kind: "head-disagrees",
        anchorNo,
        detail:
          `at entry ${auditSeq} the archive holds ${auditHash.slice(0, 16)} and this log now ` +
          `computes ${now.slice(0, 16)}. Something at or before that entry was changed.`,
      });
    }
  }

  return divergences;
}

export class Anchors {
  readonly #db: Db;
  readonly #audit: AuditLog;

  constructor(db: Db) {
    this.#db = db;
    this.#audit = new AuditLog(db);
  }

  /**
   * Create the next anchor for a tenant and store it, unsent.
   *
   * Creation and delivery are separate so a receiver being briefly unreachable
   * does not silently skip an anchor. The row exists with `delivered_at` null
   * and the sender retries it, which also means "how many anchors never
   * arrived" is a question the database can answer.
   *
   * An anchor is produced even when the audit log has not moved. A heartbeat
   * is what makes silence meaningful: without it, a receiver cannot tell a
   * quiet week from a disabled sender.
   */
  create(tenantId: string, privateKeyPem: string, now = Date.now()): Anchor {
    return this.#db.transaction(() => {
      const previous = this.#db
        .prepare(
          "SELECT anchor_no AS anchorNo, payload FROM anchors WHERE tenant_id = ? ORDER BY anchor_no DESC LIMIT 1",
        )
        .get(tenantId) as { anchorNo: number; payload: string } | undefined;

      const anchorNo = (previous?.anchorNo ?? 0) + 1;
      const prevAnchor =
        previous === undefined
          ? ANCHOR_GENESIS
          : createHash("sha256").update(previous.payload).digest("hex");

      const head = this.#audit.head(tenantId);
      const payload: AnchorPayload = {
        v: 1,
        tenant: tenantId,
        anchorNo,
        auditSeq: head.seq,
        auditHash: head.hash,
        prevAnchor,
        at: new Date(now).toISOString(),
      };

      const canonical = canonicalPayload(payload);
      const signature = sign(
        null,
        Buffer.from(canonical, "utf8"),
        createPrivateKey(privateKeyPem),
      ).toString("base64");
      const hash = createHash("sha256").update(canonical).digest("hex");

      this.#db
        .prepare(
          `INSERT INTO anchors
             (tenant_id, anchor_no, audit_seq, audit_hash, prev_anchor, payload, signature, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(tenantId, anchorNo, head.seq, head.hash, prevAnchor, canonical, signature, now);

      return { payload, signature, hash };
    })();
  }

  markDelivered(tenantId: string, anchorNo: number, now = Date.now()): void {
    this.#db
      .prepare(
        "UPDATE anchors SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE tenant_id = ? AND anchor_no = ?",
      )
      .run(now, tenantId, anchorNo);
  }

  markFailed(tenantId: string, anchorNo: number, error: string): void {
    this.#db
      .prepare(
        "UPDATE anchors SET attempts = attempts + 1, last_error = ? WHERE tenant_id = ? AND anchor_no = ?",
      )
      .run(error.slice(0, 500), tenantId, anchorNo);
  }

  /** Anchors that have not reached the receiver, oldest first. */
  undelivered(tenantId: string, limit = 50): AnchorRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT payload, signature, created_at AS createdAt, delivered_at AS deliveredAt,
                attempts, last_error AS lastError
         FROM anchors WHERE tenant_id = ? AND delivered_at IS NULL
         ORDER BY anchor_no ASC LIMIT ?`,
      )
      .all(tenantId, limit) as {
      payload: string;
      signature: string;
      createdAt: number;
      deliveredAt: number | null;
      attempts: number;
      lastError: string | null;
    }[];
    return rows.map(toRecord);
  }

  recent(tenantId: string, limit = 20): AnchorRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT payload, signature, created_at AS createdAt, delivered_at AS deliveredAt,
                attempts, last_error AS lastError
         FROM anchors WHERE tenant_id = ? ORDER BY anchor_no DESC LIMIT ?`,
      )
      .all(tenantId, limit) as {
      payload: string;
      signature: string;
      createdAt: number;
      deliveredAt: number | null;
      attempts: number;
      lastError: string | null;
    }[];
    return rows.map(toRecord);
  }

  /** Every tenant with an audit log, so the sender knows who to anchor. */
  tenantsWithHistory(): string[] {
    const rows = this.#db
      .prepare("SELECT DISTINCT tenant_id AS tenantId FROM audit_log")
      .all() as { tenantId: string }[];
    return rows.map((r) => r.tenantId);
  }
}

function toRecord(row: {
  payload: string;
  signature: string;
  createdAt: number;
  deliveredAt: number | null;
  attempts: number;
  lastError: string | null;
}): AnchorRecord {
  const payload = JSON.parse(row.payload) as unknown[];
  return {
    payload: {
      v: payload[0] as 1,
      tenant: payload[1] as string,
      anchorNo: payload[2] as number,
      auditSeq: payload[3] as number,
      auditHash: payload[4] as string,
      prevAnchor: payload[5] as string,
      at: payload[6] as string,
    },
    signature: row.signature,
    hash: createHash("sha256").update(row.payload).digest("hex"),
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt ?? undefined,
    attempts: row.attempts,
    lastError: row.lastError ?? undefined,
  };
}
