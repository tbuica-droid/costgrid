import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateMasterKey } from "@costgrid/gateway";

/**
 * The master key, kept by the operating system's secure storage.
 *
 * The key that decrypts every stored provider credential is itself encrypted
 * by Electron's safeStorage, which on a Mac means the login keychain and on
 * Windows the account's data protection. The encrypted form lives in a file
 * next to the database; the file is useless anywhere else, and useless to any
 * other program on this computer that has not been granted the keychain item.
 *
 * Written against a small interface rather than Electron's module so it can
 * be tested in plain Node with a stand-in.
 */

/** The part of Electron's safeStorage this needs. */
export interface SecureStore {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface MasterKeyOptions {
  /** Where the encrypted key is kept. Created on first run. */
  readonly file: string;
  readonly store: SecureStore;
  /**
   * A key that already exists elsewhere, to adopt rather than replace.
   *
   * On a Mac, `npm run desktop` keeps its key in the login keychain. If that
   * database is opened by the app, a new key would leave every credential in
   * it undecryptable, so the app takes over the same key instead.
   */
  readonly existing?: (() => string | undefined) | undefined;
}

export interface MasterKey {
  readonly key: string;
  readonly origin: "file" | "adopted" | "new";
}

/** Exactly what `generateMasterKey` produces; anything else is a damaged file. */
const KEY_SHAPE = /^[A-Za-z0-9_-]{32,256}$/;

export function loadMasterKey({ file, store, existing }: MasterKeyOptions): MasterKey {
  if (!store.isEncryptionAvailable()) {
    throw new Error(
      "This computer has no secure storage available to protect the key that encrypts " +
        "your provider credentials, so CostGrid cannot start.",
    );
  }

  if (existsSync(file)) {
    let key: string;
    try {
      key = store.decryptString(readFileSync(file));
    } catch (error) {
      throw new Error(
        `The master key file at ${file} could not be decrypted: ${
          error instanceof Error ? error.message : String(error)
        }. It was written by a different account or computer.`,
      );
    }
    if (!KEY_SHAPE.test(key)) throw new Error(`The master key file at ${file} is damaged.`);
    return { key, origin: "file" };
  }

  const adopted = existing?.();
  const key = adopted ?? generateMasterKey();

  // Owner-only, folder and file both, before anything secret is written.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, store.encryptString(key), { mode: 0o600 });
  chmodSync(file, 0o600);
  return { key, origin: adopted === undefined ? "new" : "adopted" };
}
