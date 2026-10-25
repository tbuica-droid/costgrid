import { randomBytes } from "node:crypto";
import { deriveFingerprintKey } from "@costgrid/core";
import type { SecretStore } from "./secret-store.js";

/**
 * The key that turns a job's first message into a one-way code.
 *
 * Kept apart from the codes it makes, so a copy of the database cannot be
 * used to test guesses: in the desktop app it is a random key in the
 * operating system's keychain; elsewhere it is derived from the master key,
 * which never sits in the database either. Undefined when neither exists,
 * and then only the developer's `x-costgrid-task` identifies jobs.
 */

/** Its own keychain account, not an admin-key one, so nothing else ever reads it. */
export const FINGERPRINT_ACCOUNT = "fingerprint:install";

export async function loadFingerprintKey(deps: {
  secretStore?: SecretStore | undefined;
  masterKey?: Uint8Array | undefined;
}): Promise<Uint8Array | undefined> {
  if (deps.secretStore !== undefined) {
    try {
      const stored = await deps.secretStore.get(FINGERPRINT_ACCOUNT);
      if (stored !== undefined && /^[0-9a-f]{64}$/.test(stored)) return Buffer.from(stored, "hex");
      const fresh = randomBytes(32);
      await deps.secretStore.set(FINGERPRINT_ACCOUNT, fresh.toString("hex"));
      return fresh;
    } catch {
      // A locked or refusing keychain: fall back rather than lose the feature.
    }
  }
  return deps.masterKey === undefined ? undefined : deriveFingerprintKey(deps.masterKey);
}
