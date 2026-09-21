import { createHash } from "node:crypto";
import type { Db } from "./database.js";

/**
 * The audit log: what happened, who did it, and proof that the answer has not
 * been edited since.
 *
 * Metering already records what the software did. This records what *people*
 * did to the software: who changed a budget, who added a provider key, who
 * turned enforcement off the week the bill tripled. Those are the events an
 * auditor asks about, and until now CostGrid could not answer.
 *
 * ## Why it is a chain
 *
 * A log that the administrator can edit proves nothing, because the
 * administrator is precisely who an audit is about. Each entry here carries
 * the hash of the entry before it, so editing or removing any entry changes
 * its hash, which breaks the link the next entry recorded, and every link
 * after that.
 *
 * This does not make the log unchangeable, and nothing that lives in a
 * database the customer owns ever could be. It makes a change **detectable**.
 * That is what "tamper-evident" means, it is a weaker claim than
 * "tamper-proof", and it is the one that is true.
 *
 * ## Making it evidence rather than a feature
 *
 * Detection only helps someone who knows what the log looked like before. The
 * head hash is that fingerprint: 64 characters that commit to the entire
 * history. Write it down somewhere CostGrid cannot reach, such as a ticket, a
 * board minute or an email to an auditor, and any later change to any entry
 * written before that moment becomes provable rather than merely suspected.
 * `costgrid audit head` exists for exactly this.
 *
 * ## What is never in here
 *
 * No prompts, no completions, no tool arguments, no credentials. The same
 * promise the rest of the product makes about content applies here, and an
 * audit log is a tempting place to break it.
 */

/** Chain start. The hash a tenant's first entry links back to. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Written when entries are deleted under a retention policy.
 *
 * A chain with a hole in it cannot be verified across the hole. Rather than
 * let verification fail with no explanation, the deletion leaves a tombstone
 * in the slot of the last entry it removed, carrying that entry's hash so the
 * surviving entry after it still links to something.
 *
 * The tombstone is the one entry whose hash is asserted rather than derived,
 * which is exactly why `verify` reports every one it finds by sequence number.
 * A declared break in the chain is honest; a silent one would not be. Nothing
 * before a tombstone can be verified by hash, and a reader should treat the
 * history on the far side of one as unproven rather than as proven false.
 */
export const TRUNCATION_ACTION = "audit.truncated";

export type ActorKind = "user" | "api-key" | "system" | "autopilot";

export interface AuditActor {
  readonly kind: ActorKind;
  readonly id: string;
  /** Email, key name or process name, captured at the time of the event. */
  readonly label: string;
}

/** Work done by the software itself, with no person behind it. */
export const SYSTEM_ACTOR: AuditActor = { kind: "system", id: "system", label: "CostGrid" };

export interface AuditEvent {
  readonly actor: AuditActor;
  /** Dotted and past tense: `credential.added`, `policy.disabled`. */
  readonly action: string;
  /** What was acted on: a policy id, a provider name, an email address. */
  readonly subject: string;
  /** Structured context. Must not contain secrets or message content. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AuditEntry extends AuditEvent {
  readonly seq: number;
  readonly occurredAt: number;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly prevHash: string;
  readonly hash: string;
}

export interface VerificationResult {
  readonly entries: number;
  /** True when every entry links to the one before it. */
  readonly intact: boolean;
  /** The first entry whose link does not hold, where there is one. */
  readonly brokenAtSeq?: number;
  readonly brokenReason?: string;
  /** Deliberate breaks left by a retention purge, each with its seq. */
  readonly truncations: readonly number[];
  /** The hash committing to the whole history, for recording elsewhere. */
  readonly head: string;
  readonly checkedAt: number;
}

interface RawEntry {
  readonly seq: bigint;
  readonly occurredAt: bigint;
  readonly actorKind: ActorKind;
  readonly actorId: string;
  readonly actorLabel: string;
  readonly action: string;
  readonly subject: string;
  readonly detail: string;
  readonly prevHash: string;
  readonly hash: string;
}

/**
 * The exact bytes a hash commits to.
 *
 * A JSON array rather than a delimiter-joined string, because a delimiter can
 * appear inside a value: `a|b` and `a`,`b` would otherwise hash identically,
 * which is a way to forge an entry. JSON escaping removes the ambiguity.
 *
 * The field order is part of the format. Changing it invalidates every chain
 * ever written, so it is fixed and new facts go into `detail`.
 */
export function chainHash(
  prevHash: string,
  entry: {
    seq: number;
    occurredAt: number;
    actorKind: string;
    actorId: string;
    actorLabel: string;
    action: string;
    subject: string;
    detail: string;
  },
): string {
  const payload = JSON.stringify([
    entry.seq,
    entry.occurredAt,
    entry.actorKind,
    entry.actorId,
    entry.actorLabel,
    entry.action,
    entry.subject,
    entry.detail,
  ]);
  return createHash("sha256").update(prevHash).update("\n").update(payload).digest("hex");
}

/**
 * Canonical JSON for the detail object: keys sorted, so two runs that record
 * the same facts produce the same hash regardless of insertion order.
 */
function canonicalDetail(detail: AuditEvent["detail"]): string {
  if (!detail) return "{}";
  const keys = Object.keys(detail).sort();
  const pairs: Record<string, string | number | boolean | null> = {};
  for (const key of keys) pairs[key] = detail[key] ?? null;
  return JSON.stringify(pairs);
}

function toEntry(raw: RawEntry): AuditEntry {
  return {
    seq: Number(raw.seq),
    occurredAt: Number(raw.occurredAt),
    actor: { kind: raw.actorKind, id: raw.actorId, label: raw.actorLabel },
    action: raw.action,
    subject: raw.subject,
    detail: JSON.parse(raw.detail) as Record<string, string | number | boolean | null>,
    prevHash: raw.prevHash,
    hash: raw.hash,
  };
}

export class AuditLog {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Append an event.
   *
   * Reading the previous hash and writing the new entry happen in one
   * transaction, so two concurrent writers cannot both claim the same
   * sequence number or link to the same predecessor.
   *
   * Recording must never break the thing being recorded: a caller that fails
   * to write an audit entry should still have performed the action, and a
   * missing entry shows up as a gap rather than as a failed request.
   */
  record(tenantId: string, event: AuditEvent, at = Date.now()): AuditEntry {
    const detail = canonicalDetail(event.detail);

    return this.#db.transaction(() => {
      const previous = this.#db
        .prepare("SELECT seq, hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1")
        .get(tenantId) as { seq: number; hash: string } | undefined;

      const seq = (previous?.seq ?? 0) + 1;
      const prevHash = previous?.hash ?? GENESIS_HASH;
      const hash = chainHash(prevHash, {
        seq,
        occurredAt: at,
        actorKind: event.actor.kind,
        actorId: event.actor.id,
        actorLabel: event.actor.label,
        action: event.action,
        subject: event.subject,
        detail,
      });

      this.#db
        .prepare(
          `INSERT INTO audit_log
             (tenant_id, seq, occurred_at, actor_kind, actor_id, actor_label,
              action, subject, detail, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenantId,
          seq,
          at,
          event.actor.kind,
          event.actor.id,
          event.actor.label,
          event.action,
          event.subject,
          detail,
          prevHash,
          hash,
        );

      return {
        seq,
        occurredAt: at,
        actor: event.actor,
        action: event.action,
        subject: event.subject,
        detail: JSON.parse(detail) as Record<string, string | number | boolean | null>,
        prevHash,
        hash,
      };
    })();
  }

  /** The hash committing to everything written so far. */
  head(tenantId: string): { seq: number; hash: string } {
    const row = this.#db
      .prepare("SELECT seq, hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1")
      .get(tenantId) as { seq: number; hash: string } | undefined;
    return row ?? { seq: 0, hash: GENESIS_HASH };
  }

  list(
    tenantId: string,
    options: {
      from?: number | undefined;
      to?: number | undefined;
      action?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): AuditEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 5000);
    const clauses = ["tenant_id = ?"];
    const params: (string | number)[] = [tenantId];

    if (options.from !== undefined) {
      clauses.push("occurred_at >= ?");
      params.push(options.from);
    }
    if (options.to !== undefined) {
      clauses.push("occurred_at < ?");
      params.push(options.to);
    }
    if (options.action !== undefined) {
      // Prefix match, so `policy` finds `policy.created` and `policy.disabled`.
      clauses.push("(action = ? OR action LIKE ? || '.%')");
      params.push(options.action, options.action);
    }

    const rows = this.#db
      .prepare(
        `SELECT seq, occurred_at AS occurredAt, actor_kind AS actorKind, actor_id AS actorId,
                actor_label AS actorLabel, action, subject, detail,
                prev_hash AS prevHash, hash
         FROM audit_log WHERE ${clauses.join(" AND ")}
         ORDER BY seq DESC LIMIT ?`,
      )
      .safeIntegers(true)
      .all(...params, limit) as RawEntry[];

    return rows.map(toEntry);
  }

  /**
   * Walk the chain and report whether it holds.
   *
   * Three things are checked per entry, and they catch different attacks. The
   * recomputed hash catches an edited field. The link to the previous hash
   * catches a removed or reordered entry. The gapless sequence catches a
   * deletion from the end, which the other two cannot see because what is
   * missing links to nothing.
   */
  verify(tenantId: string, now = Date.now()): VerificationResult {
    const rows = this.#db
      .prepare(
        `SELECT seq, occurred_at AS occurredAt, actor_kind AS actorKind, actor_id AS actorId,
                actor_label AS actorLabel, action, subject, detail,
                prev_hash AS prevHash, hash
         FROM audit_log WHERE tenant_id = ? ORDER BY seq ASC`,
      )
      .safeIntegers(true)
      .all(tenantId) as RawEntry[];

    const truncations: number[] = [];
    let expectedHash = GENESIS_HASH;
    let expectedSeq = 1;
    let head = GENESIS_HASH;

    for (const raw of rows) {
      const seq = Number(raw.seq);
      const occurredAt = Number(raw.occurredAt);

      // A retention purge removes the oldest entries and leaves a tombstone in
      // the slot of the last one. It is the only entry allowed to restart the
      // chain, and the only one whose hash is taken on trust: it carries the
      // removed entry's hash so that what follows still links. Every other seq
      // jump is missing history.
      if (raw.action === TRUNCATION_ACTION) {
        truncations.push(seq);
        expectedHash = raw.hash;
        head = raw.hash;
        expectedSeq = seq + 1;
        continue;
      }

      if (seq !== expectedSeq) {
        return {
          entries: rows.length,
          intact: false,
          brokenAtSeq: seq,
          brokenReason: `sequence jumps from ${expectedSeq} to ${seq}; ${
            seq - expectedSeq
          } entr${seq - expectedSeq === 1 ? "y is" : "ies are"} missing`,
          truncations,
          head: raw.hash,
          checkedAt: now,
        };
      }

      if (raw.prevHash !== expectedHash) {
        return {
          entries: rows.length,
          intact: false,
          brokenAtSeq: seq,
          brokenReason: "does not link to the entry before it; an entry was changed or removed",
          truncations,
          head: raw.hash,
          checkedAt: now,
        };
      }

      const recomputed = chainHash(raw.prevHash, {
        seq,
        occurredAt,
        actorKind: raw.actorKind,
        actorId: raw.actorId,
        actorLabel: raw.actorLabel,
        action: raw.action,
        subject: raw.subject,
        detail: raw.detail,
      });
      if (recomputed !== raw.hash) {
        return {
          entries: rows.length,
          intact: false,
          brokenAtSeq: seq,
          brokenReason: "contents do not match its own hash; this entry was edited in place",
          truncations,
          head: raw.hash,
          checkedAt: now,
        };
      }

      expectedHash = raw.hash;
      head = raw.hash;
      expectedSeq = seq + 1;
    }

    return { entries: rows.length, intact: true, truncations, head, checkedAt: now };
  }

  /**
   * Delete entries older than `before`, leaving a record that it happened.
   *
   * Separate from the rest of retention and never automatic, because this is
   * the one deletion that destroys evidence. The entry it writes carries the
   * hash of the last entry removed, so a verifier can see the boundary and
   * what the chain was anchored to when it was crossed.
   */
  purgeBefore(tenantId: string, before: number, actor: AuditActor, now = Date.now()): number {
    return this.#db.transaction(() => {
      const last = this.#db
        .prepare(
          `SELECT seq, hash FROM audit_log
           WHERE tenant_id = ? AND occurred_at < ?
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(tenantId, before) as { seq: number; hash: string } | undefined;

      if (!last) return 0;

      const removed = this.#db
        .prepare("DELETE FROM audit_log WHERE tenant_id = ? AND seq <= ?")
        .run(tenantId, last.seq).changes;

      // The tombstone takes the slot of the last entry it removed, and keeps
      // that entry's hash in the hash column. The next surviving entry links
      // to that value, so the chain from here forward still verifies. Written
      // by hand rather than through record(), which would have linked to a
      // head that no longer exists.
      const detail = canonicalDetail({
        removed,
        throughSeq: last.seq,
        anchorHash: last.hash,
        olderThan: new Date(before).toISOString(),
      });

      this.#db
        .prepare(
          `INSERT INTO audit_log
             (tenant_id, seq, occurred_at, actor_kind, actor_id, actor_label,
              action, subject, detail, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenantId,
          last.seq,
          now,
          actor.kind,
          actor.id,
          actor.label,
          TRUNCATION_ACTION,
          tenantId,
          detail,
          // Genesis, because nothing before this point is reachable any more.
          GENESIS_HASH,
          last.hash,
        );

      return removed;
    })();
  }
}

/**
 * The verification result in words.
 *
 * Shared by the console and the CLI so that the sentence someone pastes into a
 * security questionnaire is the same sentence either way, and so that a
 * declared break is never quietly rounded up to "all clear". A chain with a
 * tombstone in it verifies, and that is not the same as a chain nobody has
 * ever cut.
 */
export function describeVerification(result: VerificationResult): string {
  if (!result.intact) {
    const head = `Entry ${result.brokenAtSeq} does not verify: ${result.brokenReason}.`;
    // Saying "everything before it is fine" when the break is at the first
    // entry would be false comfort about a chain with nothing left to trust.
    return result.brokenAtSeq === 1
      ? `${head} That is the first entry, so nothing in this log can be relied on.`
      : `${head} Entries 1 to ${(result.brokenAtSeq ?? 1) - 1} are unaffected. ` +
        "Everything from the broken entry onwards is not trustworthy.";
  }
  if (result.entries === 0) return "There is nothing recorded yet.";

  const base =
    result.entries === 1
      ? "The single entry verifies. Nothing has been changed or removed"
      : `All ${result.entries} entries verify. Nothing has been changed or removed`;
  if (result.truncations.length === 0) return `${base}.`;

  const cuts = result.truncations.length;
  return (
    `${base} since the most recent deletion. ` +
    `${cuts} deletion${cuts === 1 ? " was" : "s were"} recorded under the retention policy ` +
    `(entr${cuts === 1 ? "y" : "ies"} ${result.truncations.join(", ")}), and history older ` +
    "than that cannot be checked by hash."
  );
}
