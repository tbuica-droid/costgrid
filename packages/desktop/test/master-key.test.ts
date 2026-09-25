import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMasterKey, type SecureStore } from "../src/master-key.js";

/** Stands in for Electron's safeStorage: reversible, and visibly not the plaintext. */
function fakeStore(available = true): SecureStore {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`sealed:${Buffer.from(plain).toString("base64")}`),
    decryptString: (sealed) => {
      const text = sealed.toString();
      if (!text.startsWith("sealed:")) throw new Error("not sealed by this store");
      return Buffer.from(text.slice(7), "base64").toString();
    },
  };
}

describe("the desktop master key", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "costgrid-key-"));
    file = join(dir, "data", "master-key.enc");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a key on first run and reads the same one back", () => {
    const store = fakeStore();
    const first = loadMasterKey({ file, store });
    expect(first.origin).toBe("new");
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{64}$/);

    const again = loadMasterKey({ file, store });
    expect(again).toEqual({ key: first.key, origin: "file" });
  });

  it("never writes the key in clear, and keeps the file to its owner", () => {
    const { key } = loadMasterKey({ file, store: fakeStore() });
    expect(readFileSync(file).toString()).not.toContain(key);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o700);
    }
  });

  it("adopts a key that already exists rather than stranding what it encrypted", () => {
    const existing = () => "k".repeat(64);
    const first = loadMasterKey({ file, store: fakeStore(), existing });
    expect(first).toEqual({ key: "k".repeat(64), origin: "adopted" });

    // Once written, the file wins; the older source is not consulted again.
    const again = loadMasterKey({ file, store: fakeStore(), existing: () => "other-key-that-is-long-enough-00" });
    expect(again).toEqual({ key: "k".repeat(64), origin: "file" });
  });

  it("refuses to run without secure storage", () => {
    expect(() => loadMasterKey({ file, store: fakeStore(false) })).toThrow(/no secure storage/);
  });

  it("says so when the file cannot be read by this store", () => {
    loadMasterKey({ file, store: fakeStore() });
    const other: SecureStore = { ...fakeStore(), decryptString: () => { throw new Error("wrong account"); } };
    expect(() => loadMasterKey({ file, store: other })).toThrow(/could not be decrypted.*wrong account/);
  });

  it("rejects a damaged file rather than using whatever is in it", () => {
    const store = fakeStore();
    writeFileSync(file.replace("data/", "") , "");
    loadMasterKey({ file, store });
    writeFileSync(file, store.encryptString("not a key"));
    expect(() => loadMasterKey({ file, store })).toThrow(/damaged/);
  });
});
