import { describe, expect, it } from "vitest";
import { usd } from "../src/money.js";
import { computeInvoice, PLANS, planFor } from "../src/billing.js";
import {
  decryptSecret,
  deriveMasterKey,
  encryptSecret,
  generateSessionToken,
  hashPassword,
  hashToken,
  maskSecret,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from "../src/secrets.js";

const SECRET = "a-master-key-long-enough-to-be-accepted-0123456789";
const KEY = deriveMasterKey(SECRET);

describe("master key derivation", () => {
  it("is deterministic, so restarts can still decrypt", () => {
    expect(deriveMasterKey(SECRET).equals(deriveMasterKey(SECRET))).toBe(true);
  });

  it("differs for a different secret", () => {
    expect(deriveMasterKey(SECRET).equals(deriveMasterKey(`${SECRET}x`))).toBe(false);
  });

  it("refuses a short secret rather than deriving a weak key", () => {
    expect(() => deriveMasterKey("too-short")).toThrow(/at least 32 characters/);
  });
});

describe("secret envelopes", () => {
  it("round-trips a provider key", () => {
    const apiKey = "sk-ant-api03-not-a-real-key-value";
    const envelope = encryptSecret(apiKey, KEY);

    expect(envelope).not.toContain(apiKey); // the plaintext is not in there
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(decryptSecret(envelope, KEY)).toBe(apiKey);
  });

  it("produces a different ciphertext each time", () => {
    // A fixed IV would let an observer see that two tenants stored the same
    // key, or that a key was unchanged across a rotation.
    const a = encryptSecret("same-value", KEY);
    const b = encryptSecret("same-value", KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it("refuses to decrypt with the wrong master key", () => {
    const envelope = encryptSecret("sk-secret", KEY);
    const otherKey = deriveMasterKey("a-completely-different-master-key-0123456789");
    expect(() => decryptSecret(envelope, otherKey)).toThrow(/could not decrypt/);
  });

  it("detects tampering rather than returning corrupted plaintext", () => {
    // GCM authenticates: a flipped byte must fail, not yield a mangled key
    // that would then be sent to a provider.
    const envelope = encryptSecret("sk-secret-value", KEY);
    const parts = envelope.split(".");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    ciphertext[0] ^= 0xff;
    parts[3] = ciphertext.toString("base64url");

    expect(() => decryptSecret(parts.join("."), KEY)).toThrow(/could not decrypt/);
  });

  it("rejects an unrecognised envelope format", () => {
    expect(() => decryptSecret("not-an-envelope", KEY)).toThrow(/not a recognised envelope/);
    expect(() => decryptSecret("v2.a.b.c", KEY)).toThrow(/not a recognised envelope/);
  });
});

describe("maskSecret", () => {
  it("shows only the last four characters", () => {
    expect(maskSecret("sk-ant-api03-abcdefgh")).toBe("********efgh");
    expect(maskSecret("abc")).toBe("****");
  });
});

describe("password hashing", () => {
  // Low cost keeps these tests fast; production uses the default.
  const cheap = (password: string) => hashPassword(password, 1024);

  it("verifies a correct password", () => {
    const stored = cheap("correct-horse-battery");
    expect(verifyPassword("correct-horse-battery", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = cheap("correct-horse-battery");
    expect(verifyPassword("correct-horse-batteryy", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("salts, so identical passwords hash differently", () => {
    expect(cheap("identical-password")).not.toBe(cheap("identical-password"));
  });

  it("enforces a minimum length at hash time", () => {
    expect(() => cheap("short")).toThrow(/at least 12 characters/);
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it("returns false on a malformed stored hash instead of throwing", () => {
    // A corrupted row must fail the login, not crash the endpoint — which
    // would itself reveal that the account exists.
    for (const bad of ["", "garbage", "scrypt$notanumber$a$b", "bcrypt$1$a$b", "scrypt$1024$!!$!!"]) {
      expect(verifyPassword("anything", bad), bad).toBe(false);
    }
  });

  it("never verifies against a truncated or empty hash field", () => {
    // Regression: an empty expected hash made timingSafeEqual(empty, empty)
    // return true, so a corrupted row accepted every password.
    const salt = "a".repeat(24);
    for (const bad of [
      `scrypt$1024$${salt}$`,
      `scrypt$1024$${salt}$aGk`, // 2 bytes
      `scrypt$1024$$${"z".repeat(88)}`, // empty salt
    ]) {
      expect(verifyPassword("anything", bad), bad).toBe(false);
      expect(verifyPassword("", bad), bad).toBe(false);
    }
  });

  it("carries its cost parameter, so it can be raised later", () => {
    const stored = hashPassword("a-valid-password-x", 2048);
    expect(stored.split("$")[1]).toBe("2048");
    expect(verifyPassword("a-valid-password-x", stored)).toBe(true);
  });
});

describe("session tokens", () => {
  it("stores only a hash of the token", () => {
    const { token, hash } = generateSessionToken();
    expect(hash).not.toBe(token);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
  });

  it("generates distinct tokens", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateSessionToken().token));
    expect(seen.size).toBe(100);
  });
});

describe("billing", () => {
  it("charges the flat monthly fee and nothing else", () => {
    const invoice = computeInvoice("team", usd("10000.00"), 5_000);
    expect(invoice.total).toBe(usd("99.00"));
  });

  it("charges nothing on the free plan", () => {
    const invoice = computeInvoice("free", usd("500.00"), 100);
    expect(invoice.total).toBe(0n);
  });

  /*
   * The property that replaced the old spend share, and the reason it was
   * removed: this product reduces a customer's AI bill, so a fee taken as a
   * percentage of that bill fell as the product worked. A buyer doing the
   * arithmetic could see we were paid to save them less.
   */
  it("charges the same however much the customer spends", () => {
    const small = computeInvoice("team", usd("100.00"), 1_000);
    const large = computeInvoice("team", usd("250000.00"), 9_000_000);
    expect(small.total).toBe(large.total);
  });

  it("keeps the customer's spend on the invoice without billing on it", () => {
    // Shown side by side, because "you spent $50,000, we charged you $499" is
    // the argument for the product on one line.
    const invoice = computeInvoice("business", usd("50000.00"), 1_000);
    expect(invoice.meteredSpend).toBe(usd("50000.00"));
    expect(invoice.total).toBe(usd("499.00"));
  });

  it("never meters calls, because a self-hosted product cannot count them", () => {
    const quiet = computeInvoice("free", 0n, 0);
    const busy = computeInvoice("free", 0n, 50_000_000);
    expect(quiet.total).toBe(busy.total);
  });

  it("validates its inputs", () => {
    expect(() => computeInvoice("team", -1n, 0)).toThrow(/cannot be negative/);
    expect(() => computeInvoice("team", 0n, -1)).toThrow(/non-negative integer/);
    expect(() => planFor("enterprise")).toThrow(/unknown plan/);
  });

  it("raises the rate limit as plans grow", () => {
    expect(PLANS.free.rateLimitPerMinute).toBeLessThan(PLANS.team.rateLimitPerMinute);
    expect(PLANS.team.rateLimitPerMinute).toBeLessThan(PLANS.business.rateLimitPerMinute);
  });
});
