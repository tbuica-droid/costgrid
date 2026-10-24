import type { SecretStore } from "@costgrid/gateway";

/**
 * Admin keys kept by the operating system: the login keychain on a Mac, the
 * Credential Manager on Windows.
 *
 * Backed by `@napi-rs/keyring` (a prebuilt Node-API module, so nothing is
 * compiled on install). It is loaded here, in the desktop app, so the gateway
 * never loads native code. If the module is missing, or this computer's
 * keychain refuses a test entry, there is no store and the console says an
 * admin key will be used once and not kept, rather than failing later with a
 * key half saved.
 *
 * Written against the small slice of the library it uses, loaded with a
 * dynamic import, so it builds and is testable without the native module.
 */

/** The part of `@napi-rs/keyring`'s `AsyncEntry` this needs (2.1.0). */
export interface KeyringEntry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | undefined | null>;
  /** True when a credential was deleted, false when there was none. */
  deleteCredential(): Promise<boolean>;
}

export type KeyringEntryClass = new (
  service: string,
  account: string,
  options?: { linux?: { store?: "secret-service" | "keyutils" } },
) => KeyringEntry;

export interface KeyringModule {
  readonly AsyncEntry?: KeyringEntryClass;
  readonly default?: { readonly AsyncEntry?: KeyringEntryClass };
}

export const KEYRING_SERVICE = "dev.costgrid.desktop";
const KEYRING_MODULE = "@napi-rs/keyring";
const PROBE_ACCOUNT = "costgrid-probe";

/** A variable rather than a literal, so TypeScript does not need the package installed to build. */
const loadKeyring = (): Promise<KeyringModule> => import(KEYRING_MODULE) as Promise<KeyringModule>;

/**
 * The keychain as a `SecretStore`, or undefined when there is none.
 *
 * Probes once by writing, reading back and deleting a throwaway entry. The
 * error from a failed probe is not kept: a keychain library may describe what
 * it was asked to store.
 */
export async function keyringSecretStore(
  service = KEYRING_SERVICE,
  load: () => Promise<KeyringModule> = loadKeyring,
): Promise<SecretStore | undefined> {
  try {
    const lib = await load();
    const Entry = lib.AsyncEntry ?? lib.default?.AsyncEntry;
    if (typeof Entry !== "function") return undefined;

    // On Linux, the Secret Service only: the kernel keyring it would
    // otherwise fall back to forgets everything at reboot.
    const entry = (account: string): KeyringEntry =>
      new Entry(service, account, { linux: { store: "secret-service" } });

    const probe = entry(PROBE_ACCOUNT);
    const token = `probe-${Date.now()}`;
    let read: string | undefined | null;
    try {
      await probe.setPassword(token);
      read = await probe.getPassword();
    } finally {
      // Always tidied away; a store that cannot delete is no store.
      await probe.deleteCredential();
    }
    if (read !== token) return undefined;

    return {
      kind: "os-keychain",
      async get(account) {
        return (await entry(account).getPassword()) ?? undefined;
      },
      async set(account, secret) {
        await entry(account).setPassword(secret);
      },
      async delete(account) {
        return entry(account).deleteCredential();
      },
    };
  } catch {
    return undefined;
  }
}
