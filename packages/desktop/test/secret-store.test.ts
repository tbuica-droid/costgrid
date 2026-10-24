import { describe, expect, it } from "vitest";
import { type KeyringEntry, type KeyringModule, keyringSecretStore } from "../src/secret-store.js";

/**
 * Stands in for `@napi-rs/keyring`'s AsyncEntry: one shared map per fake
 * keychain, keyed by service and account, the way the real one is.
 */
function fakeKeyring(options: { failOn?: "set" | "get" | "delete"; garble?: boolean } = {}) {
  const entries = new Map<string, string>();
  const constructed: { service: string; account: string; options: unknown }[] = [];

  class AsyncEntry implements KeyringEntry {
    readonly #key: string;
    constructor(service: string, account: string, opts?: unknown) {
      constructed.push({ service, account, options: opts });
      this.#key = `${service}\u0000${account}`;
    }
    async setPassword(password: string): Promise<void> {
      if (options.failOn === "set") throw new Error("User interaction is not allowed.");
      entries.set(this.#key, options.garble ? `${password}!` : password);
    }
    async getPassword(): Promise<string | undefined> {
      if (options.failOn === "get") throw new Error("The keychain is locked.");
      return entries.get(this.#key);
    }
    async deleteCredential(): Promise<boolean> {
      if (options.failOn === "delete") throw new Error("Access denied.");
      return entries.delete(this.#key);
    }
  }

  return { entries, constructed, module: { AsyncEntry } as KeyringModule };
}

describe("the desktop keychain store", () => {
  it("probes, then keeps, returns and deletes secrets under its own service", async () => {
    const fake = fakeKeyring();
    const store = await keyringSecretStore("test.costgrid", async () => fake.module);

    expect(store?.kind).toBe("os-keychain");
    // The probe tidied up after itself.
    expect(fake.entries.size).toBe(0);

    await store!.set("admin:t1:openai", "sk-admin-secret");
    expect(fake.entries.get("test.costgrid\u0000admin:t1:openai")).toBe("sk-admin-secret");
    expect(await store!.get("admin:t1:openai")).toBe("sk-admin-secret");
    expect(await store!.get("admin:t1:anthropic")).toBeUndefined();
    expect(await store!.delete("admin:t1:openai")).toBe(true);
    expect(await store!.delete("admin:t1:openai")).toBe(false);

    // Never the kernel keyring on Linux, which forgets at reboot.
    expect(fake.constructed.every((c) => JSON.stringify(c.options) === '{"linux":{"store":"secret-service"}}')).toBe(true);
  });

  it("accepts the module through a default export too", async () => {
    const fake = fakeKeyring();
    const store = await keyringSecretStore("test.costgrid", async () => ({ default: fake.module }) as KeyringModule);
    expect(store).toBeDefined();
  });

  it("reads null from the library as nothing there", async () => {
    const fake = fakeKeyring();
    const store = await keyringSecretStore("test.costgrid", async () => fake.module);
    const Entry = fake.module.AsyncEntry!;
    const original = Entry.prototype.getPassword;
    Entry.prototype.getPassword = async () => null;
    expect(await store!.get("admin:t1:openai")).toBeUndefined();
    Entry.prototype.getPassword = original;
  });

  it("is unavailable when the keychain refuses the probe", async () => {
    for (const failOn of ["set", "get", "delete"] as const) {
      const fake = fakeKeyring({ failOn });
      expect(await keyringSecretStore("test.costgrid", async () => fake.module), failOn).toBeUndefined();
    }
    // A store that does not give back what it was given is no store either.
    const garbled = fakeKeyring({ garble: true });
    expect(await keyringSecretStore("test.costgrid", async () => garbled.module)).toBeUndefined();
    expect(garbled.entries.size).toBe(0);
  });

  it("is unavailable when the module is missing or is not the expected shape", async () => {
    const missing = async (): Promise<KeyringModule> => {
      throw Object.assign(new Error("Cannot find module '@napi-rs/keyring'"), { code: "ERR_MODULE_NOT_FOUND" });
    };
    expect(await keyringSecretStore("test.costgrid", missing)).toBeUndefined();
    expect(await keyringSecretStore("test.costgrid", async () => ({}))).toBeUndefined();
  });
});
