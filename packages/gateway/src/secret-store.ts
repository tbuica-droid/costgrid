/**
 * Where a stored admin key lives: the operating system's keychain, never the
 * database.
 *
 * The gateway only knows this interface. The desktop app hands it an
 * implementation backed by the Mac keychain or the Windows Credential Manager
 * (`packages/desktop/src/secret-store.ts`), so the gateway itself never loads
 * native code. A self-hosted server passes nothing, and an admin key is then
 * used once and dropped, as before.
 *
 * Nothing that implements this may log a secret, and nothing that calls it
 * may put one in an error message: errors from a store are reported by what
 * failed, never by what was being stored.
 */

export interface SecretStore {
  /** "memory" is for tests: it forgets everything when the process ends. */
  readonly kind: "os-keychain" | "memory";
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  /** True when something was there to delete. */
  delete(account: string): Promise<boolean>;
}

/**
 * Tenant ids are UUIDs (or `local`); providers are lowercase words. Anything
 * else is refused before it can become part of a keychain account name, so
 * one tenant's request can never name another tenant's entry.
 */
const TENANT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** The keychain account an admin key is stored under. Throws on an unsafe part. */
export function adminKeyAccount(tenantId: string, provider: string): string {
  if (!TENANT_PATTERN.test(tenantId)) throw new RangeError("not a valid tenant id");
  if (!PROVIDER_PATTERN.test(provider)) throw new RangeError("not a valid provider");
  return `admin:${tenantId}:${provider}`;
}

/** A store that keeps secrets in this process only. For tests. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "memory" as const;
  readonly #secrets = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.#secrets.get(account);
  }

  async set(account: string, secret: string): Promise<void> {
    this.#secrets.set(account, secret);
  }

  async delete(account: string): Promise<boolean> {
    return this.#secrets.delete(account);
  }

  /** How many entries are held, so a test can prove nothing was kept. */
  get size(): number {
    return this.#secrets.size;
  }
}
