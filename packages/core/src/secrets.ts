import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Encryption and password hashing for the hosted control plane.
 *
 * Two secrets live in the database and neither may ever be recoverable from a
 * dump alone: a tenant's provider API key (which spends their money) and a
 * user's password. Provider keys must be *decryptable* — the gateway has to
 * present them upstream — so they are encrypted with a master key held outside
 * the database. Passwords must not be, so they are hashed.
 *
 * No I/O here, so all of it is testable without a database or a network.
 */

// ---------------------------------------------------------------- envelopes

const CIPHER = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;
const SCRYPT_COST = 16_384;

/**
 * Derive the master encryption key from the operator's secret.
 *
 * scrypt rather than using the secret directly, so a short or low-entropy
 * `COSTGRID_MASTER_KEY` is still stretched into a full-length key. The salt is
 * fixed and public because the input is already a high-value operator secret,
 * not a user password — the goal is key derivation, not offline-guess
 * resistance, and a random salt would make the key unreproducible across
 * restarts.
 */
export function deriveMasterKey(secret: string): Buffer {
  if (secret.length < 32) {
    throw new RangeError(
      "COSTGRID_MASTER_KEY must be at least 32 characters. " +
        "Generate one with: openssl rand -base64 48",
    );
  }
  return scryptSync(secret, "costgrid.master.v1", KEY_BYTES, { N: SCRYPT_COST });
}

/**
 * Encrypt a secret for storage.
 *
 * Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix
 * exists so the algorithm can change later without guessing at what old rows
 * contain.
 */
export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  if (masterKey.length !== KEY_BYTES) {
    throw new RangeError(`master key must be ${KEY_BYTES} bytes, got ${masterKey.length}`);
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a stored secret.
 *
 * GCM authenticates the ciphertext, so a tampered or truncated row throws
 * rather than yielding a corrupted key that would be sent upstream.
 */
export function decryptSecret(envelope: string, masterKey: Buffer): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("stored secret is not a recognised envelope");
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;
  const decipher = createDecipheriv(CIPHER, masterKey, Buffer.from(ivPart!, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart!, "base64url"));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart!, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Either the master key changed or the row was tampered with. Both are
    // operator emergencies; neither should surface as a usable value.
    throw new Error(
      "could not decrypt stored secret — COSTGRID_MASTER_KEY may have changed since it was written",
    );
  }
}

/**
 * A non-secret hint for display: last four characters, everything else masked.
 * Enough for a customer to recognise which key is stored, useless to a thief.
 */
export function maskSecret(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return plaintext.length <= 4 ? "****" : `${"*".repeat(8)}${tail}`;
}

// ---------------------------------------------------------------- passwords

const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 64;
const PASSWORD_COST = 16_384;

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Hash a password with scrypt.
 *
 * Format is `scrypt$<N>$<salt>$<hash>`, so the cost parameter travels with the
 * hash and can be raised later without invalidating existing passwords.
 */
export function hashPassword(password: string, cost = PASSWORD_COST): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new RangeError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const hash = scryptSync(password, salt, PASSWORD_HASH_BYTES, { N: cost });
  return ["scrypt", String(cost), salt.toString("base64url"), hash.toString("base64url")].join("$");
}

/**
 * Verify a password against a stored hash, in constant time.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted row must
 * fail the login, not crash the endpoint (which would leak that the account
 * exists).
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;

  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost <= 0) return false;

  try {
    const salt = Buffer.from(parts[2]!, "base64url");
    const expected = Buffer.from(parts[3]!, "base64url");

    // A truncated or empty hash field must never verify. Without this floor,
    // a row like `scrypt$1024$x$` decodes to a zero-length expected value and
    // `timingSafeEqual(empty, empty)` returns true — accepting any password.
    if (salt.length < PASSWORD_SALT_BYTES || expected.length < PASSWORD_HASH_BYTES) return false;

    const actual = scryptSync(password, salt, expected.length, { N: cost });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Generate an opaque session token, and the hash to store for it.
 *
 * Only the hash is persisted, so a leaked database does not hand an attacker
 * live sessions — the same reasoning as API keys.
 */
export function generateSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  // A session token is already 256 bits of entropy, so a plain digest is
  // sufficient — there is nothing to brute-force. scrypt here would only add
  // latency to every authenticated request.
  return scryptSync(token, "costgrid.session.v1", 32, { N: 1024 }).toString("base64url");
}
