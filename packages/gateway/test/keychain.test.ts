import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateMasterKey,
  type KeychainRunner,
  readMasterKey,
  storeMasterKey,
} from "../src/keychain.js";

/** A runner that records what it was asked and answers with a canned result. */
function fakeRunner(result: { status: number; stdout?: string; stderr?: string }) {
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
  const run: KeychainRunner = (args, input) => {
    calls.push({ args, input });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { run, calls };
}

const MAC = { platform: "darwin" as const };

describe("master key in the keychain", () => {
  it("generates a 64-character base64url key", () => {
    const key = generateMasterKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(generateMasterKey()).not.toBe(key);
  });

  it("reads a stored key and trims the trailing newline", () => {
    const { run, calls } = fakeRunner({ status: 0, stdout: "stored-key-value\n" });
    expect(readMasterKey({ ...MAC, run })).toBe("stored-key-value");
    expect(calls[0]!.args).toEqual([
      "find-generic-password", "-s", "dev.costgrid.gateway", "-a", "master-key", "-w",
    ]);
  });

  it("answers undefined, not an error, when there is no key yet", () => {
    const { run } = fakeRunner({ status: 44, stderr: "could not be found" });
    expect(readMasterKey({ ...MAC, run })).toBeUndefined();
  });

  it("says what went wrong when the keychain cannot be read", () => {
    const { run } = fakeRunner({ status: 36, stderr: "User interaction is not allowed." });
    expect(() => readMasterKey({ ...MAC, run })).toThrow(/User interaction is not allowed.*unlock/);
  });

  it("refuses to pretend on anything but macOS", () => {
    const { run, calls } = fakeRunner({ status: 0, stdout: "x" });
    expect(() => readMasterKey({ platform: "linux", run })).toThrow(/macOS only/);
    expect(calls).toHaveLength(0);
  });

  it("stores through stdin, so the key never appears in the process list", () => {
    const key = generateMasterKey();
    const { run, calls } = fakeRunner({ status: 0 });
    expect(storeMasterKey(key, { ...MAC, run })).toBe("created");

    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.args.join(" ")).not.toContain(key);
    expect(calls[0]!.input).toContain(key);
    // No -U: an existing key must be refused by the keychain, never replaced.
    expect(calls[0]!.input).not.toMatch(/\s-U\s/);
  });

  it("reports an existing key rather than replacing it", () => {
    const { run } = fakeRunner({ status: 45, stderr: "already exists" });
    expect(storeMasterKey(generateMasterKey(), { ...MAC, run })).toBe("exists");
  });

  it("keeps the key out of its own error messages", () => {
    const key = generateMasterKey();
    const { run } = fakeRunner({ status: 1, stderr: `failed while adding ${key}` });
    let message = "";
    try {
      storeMasterKey(key, { ...MAC, run });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/\[redacted\]/);
    expect(message).not.toContain(key);
  });

  it("refuses anything that could smuggle a second command into security -i", () => {
    const { run, calls } = fakeRunner({ status: 0 });
    expect(() => storeMasterKey("short", { ...MAC, run })).toThrow(RangeError);
    expect(() => storeMasterKey(`${generateMasterKey()}\ndelete-keychain`, { ...MAC, run })).toThrow(RangeError);
    expect(() =>
      storeMasterKey(generateMasterKey(), { ...MAC, run, keychain: "/tmp/with space.keychain-db" }),
    ).toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

/*
 * The real thing, against a throwaway keychain file, never the login keychain.
 * macOS only, and it checks the user's keychain search list is left exactly as
 * it was found.
 */
describe.skipIf(process.platform !== "darwin")("master key against a real macOS keychain", () => {
  const security = (...args: string[]) => spawnSync("/usr/bin/security", args, { encoding: "utf8" });
  let dir: string;
  let keychain: string;
  let searchListBefore: string;

  beforeAll(() => {
    searchListBefore = security("list-keychains", "-d", "user").stdout;
    dir = mkdtempSync(join(tmpdir(), "costgrid-keychain-"));
    keychain = join(dir, "test.keychain-db");
    expect(security("create-keychain", "-p", "throwaway", keychain).status).toBe(0);
    security("set-keychain-settings", keychain); // no auto-lock mid-test
    expect(security("unlock-keychain", "-p", "throwaway", keychain).status).toBe(0);
  });

  afterAll(() => {
    security("delete-keychain", keychain);
    rmSync(dir, { recursive: true, force: true });
    expect(security("list-keychains", "-d", "user").stdout).toBe(searchListBefore);
  });

  it("round-trips a key, and a second store leaves the first in place", () => {
    const options = { keychain, service: "dev.costgrid.test" };
    expect(readMasterKey(options)).toBeUndefined();

    const first = generateMasterKey();
    expect(storeMasterKey(first, options)).toBe("created");
    expect(readMasterKey(options)).toBe(first);

    expect(storeMasterKey(generateMasterKey(), options)).toBe("exists");
    expect(readMasterKey(options)).toBe(first);
  });
});
