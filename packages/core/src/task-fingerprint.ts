import { createHmac, hkdfSync } from "node:crypto";

/**
 * A one-way code for "the same job", made from the job's first message.
 *
 * Outcome detection needs to know when a job is asked again. Without an
 * `x-costgrid-task` header from the developer, the only clue is that two runs
 * start with the same message. The message is normalised and turned into a
 * keyed HMAC; the text itself is never kept. The key never sits beside the
 * codes (the desktop app keeps it in the operating system's keychain), so a
 * copy of the database cannot be used to test guesses against them.
 */

/** Openings shorter than this ("hi", "help") cannot tell jobs apart. */
export const MIN_OPENING_CHARS = 12;
/** 128 bits: no accidental collisions, and half the storage of a full digest. */
const DIGEST_HEX_CHARS = 32;

export function normaliseOpening(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The code for an opening, or undefined when it is too short to identify a job. */
export function fingerprintOpening(key: Uint8Array, text: string): string | undefined {
  const opening = normaliseOpening(text);
  if (opening.length < MIN_OPENING_CHARS) return undefined;
  return createHmac("sha256", key).update(opening, "utf8").digest("hex").slice(0, DIGEST_HEX_CHARS);
}

/** A fingerprint key derived from the master key, for installs without a keychain. */
export function deriveFingerprintKey(masterKey: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, "costgrid", "costgrid.task-fingerprint.v1", 32));
}

/**
 * Each organisation's own key, from the install's key, so the same message
 * sent by two organisations on one install never gives the same code.
 */
export function tenantFingerprintKey(installKey: Uint8Array, tenantId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", installKey, tenantId, "costgrid.task-fingerprint.tenant.v1", 32));
}
