import { describe, expect, it } from "vitest";
import { deriveFingerprintKey, fingerprintOpening, MIN_OPENING_CHARS, normaliseOpening } from "../src/index.js";

/** The one-way code for "the same job". The text must never be recoverable or kept. */

const KEY = Buffer.alloc(32, 7);

describe("task fingerprints", () => {
  it("gives the same code for the same opening, however it is spaced or capitalised", () => {
    const a = fingerprintOpening(KEY, "  My order 4812 never arrived ");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprintOpening(KEY, "my  ORDER 4812\nnever arrived")).toBe(a);
    expect(fingerprintOpening(KEY, "My order 4813 never arrived")).not.toBe(a);
  });

  it("depends on the key, so a copy of the codes cannot be used to test guesses", () => {
    const text = "My order 4812 never arrived";
    expect(fingerprintOpening(Buffer.alloc(32, 8), text)).not.toBe(fingerprintOpening(KEY, text));
  });

  it("ignores openings too short to tell jobs apart", () => {
    expect(fingerprintOpening(KEY, "hi")).toBeUndefined();
    expect(fingerprintOpening(KEY, "x".repeat(MIN_OPENING_CHARS - 1))).toBeUndefined();
    expect(fingerprintOpening(KEY, "x".repeat(MIN_OPENING_CHARS))).toBeDefined();
    expect(normaliseOpening("  A\t\tB  ")).toBe("a b");
  });

  it("derives a stable key from the master key where there is no keychain", () => {
    const master = Buffer.alloc(32, 1);
    expect(deriveFingerprintKey(master)).toEqual(deriveFingerprintKey(master));
    expect(deriveFingerprintKey(master)).toHaveLength(32);
    expect(deriveFingerprintKey(master).equals(master)).toBe(false);
  });
});
