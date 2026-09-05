import { describe, expect, it } from "vitest";
import { NANO_PER_USD, sumNano, toUsdNumber, toUsdString, usd } from "../src/money.js";

describe("usd", () => {
  it("parses whole and fractional dollars exactly", () => {
    expect(usd("1")).toBe(1_000_000_000n);
    expect(usd("0.01")).toBe(10_000_000n);
    expect(usd("12.345678901")).toBe(12_345_678_901n); // full nanodollar resolution
    expect(usd("12.3456789")).toBe(12_345_678_900n); // trailing places zero-padded
    expect(usd("-2.50")).toBe(-2_500_000_000n);
  });

  it("parses a float without inheriting its representation error", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; the parsed values must still be exact.
    expect(usd(0.1) + usd(0.2)).toBe(usd("0.3"));
    expect(usd(0.1)).toBe(100_000_000n);
  });

  it("rejects amounts finer than a nanodollar", () => {
    expect(() => usd("0.0000000001")).toThrow(/9 decimal places/);
  });

  it("rejects malformed input", () => {
    expect(() => usd("$5")).toThrow(/not a decimal USD amount/);
    expect(() => usd("1e6")).toThrow(/not a decimal USD amount/);
    expect(() => usd(Number.NaN)).toThrow(/not finite/);
  });
});

describe("summation", () => {
  it("stays exact across a million small amounts, where floats would drift", () => {
    const perCall = usd("0.000123456");
    const total = sumNano(Array.from({ length: 1_000_000 }, () => perCall));

    // Exactly 1e6 * 0.000123456 = 123.456
    expect(total).toBe(usd("123.456"));
    expect(toUsdString(total, 3)).toBe("123.456");

    // The float equivalent does not land on the same value.
    const floatTotal = Array.from({ length: 1_000_000 }, () => 0.000123456).reduce(
      (a, b) => a + b,
      0,
    );
    expect(floatTotal).not.toBe(123.456);
  });

  it("has headroom well past the 2^53 float-integer ceiling", () => {
    const tenMillionDollars = 10_000_000n * NANO_PER_USD;
    expect(tenMillionDollars > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(toUsdString(tenMillionDollars, 2)).toBe("10000000.00");
  });
});

describe("formatting", () => {
  it("truncates to the requested precision without losing the whole part", () => {
    expect(toUsdString(usd("0.000000001"), 9)).toBe("0.000000001");
    expect(toUsdString(usd("1234.5678"), 2)).toBe("1234.56");
    expect(toUsdString(usd("1234.5678"), 0)).toBe("1234");
    expect(toUsdString(usd("-0.50"), 2)).toBe("-0.50");
  });

  it("converts to float only at the display edge", () => {
    expect(toUsdNumber(usd("12.34"))).toBeCloseTo(12.34, 10);
  });
});
