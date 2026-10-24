import { describe, expect, it } from "vitest";
import { toUsdString, usd } from "../src/money.js";
import {
  compareRatio,
  formatPercent,
  formatRatio,
  formatUsdPerOutcome,
  ratio,
  ratioEquals,
  ratioToNumber,
} from "../src/ratio.js";

describe("ratio", () => {
  it("keeps the denominator positive and the terms as given", () => {
    expect(ratio(3n, -4n)).toEqual({ num: -3n, den: 4n });
    expect(ratio(-3n, -4n)).toEqual({ num: 3n, den: 4n });
    expect(ratio(2n, 4n)).toEqual({ num: 2n, den: 4n }); // not reduced
  });

  it("refuses a zero denominator", () => {
    expect(() => ratio(1n, 0n)).toThrow(RangeError);
  });

  it("compares by value, by cross-multiplication", () => {
    expect(compareRatio(ratio(1n, 3n), ratio(1n, 2n))).toBe(-1);
    expect(compareRatio(ratio(2n, 3n), ratio(1n, 2n))).toBe(1);
    expect(compareRatio(ratio(-1n, 2n), ratio(1n, -2n))).toBe(0);
    expect(ratioEquals(ratio(1n, 2n), ratio(2n, 4n))).toBe(true);
    expect(ratioEquals(ratio(usd("3040"), 7800n), ratio(usd("304"), 780n))).toBe(true);
    expect(ratioEquals(ratio(usd("3040"), 7800n), ratio(3040n, 7800n))).toBe(false); // units matter
  });

  it("rounds once, half away from zero", () => {
    expect(formatRatio(ratio(5n, 2n), 0)).toBe("3");
    expect(formatRatio(ratio(-5n, 2n), 0)).toBe("-3");
    expect(formatRatio(ratio(1n, 3n), 3)).toBe("0.333");
  });
});

describe("formatRatio", () => {
  it("rounds exact halves away from zero", () => {
    expect(formatRatio(ratio(1n, 8n), 2)).toBe("0.13"); // 0.125
    expect(formatRatio(ratio(-1n, 8n), 2)).toBe("-0.13");
    expect(formatRatio(ratio(5n, 2n), 0)).toBe("3");
    expect(formatRatio(ratio(1n, 20n), 1)).toBe("0.1"); // 0.05
  });

  it("rounds below a half down and pads small values", () => {
    expect(formatRatio(ratio(1n, 3n), 3)).toBe("0.333");
    expect(formatRatio(ratio(2n, 3n), 3)).toBe("0.667");
    expect(formatRatio(ratio(1n, 1000n), 1)).toBe("0.0");
    expect(formatRatio(ratio(71n, 22n), 1)).toBe("3.2");
    expect(formatRatio(ratio(1234n, 1n), 2)).toBe("1234.00");
  });

  it("rejects an unusable precision", () => {
    expect(() => formatRatio(ratio(1n, 2n), -1)).toThrow(RangeError);
    expect(() => formatRatio(ratio(1n, 2n), 1.5)).toThrow(RangeError);
  });
});

describe("formatPercent and formatUsdPerOutcome", () => {
  it("shows a share as a percentage", () => {
    expect(formatPercent(ratio(1160n, 3040n), 1)).toBe("38.2");
    expect(formatPercent(ratio(7800n, 9800n), 1)).toBe("79.6");
    expect(formatPercent(ratio(1n, 1n), 0)).toBe("100");
  });

  it("shows nanodollars per outcome as dollars", () => {
    expect(formatUsdPerOutcome(ratio(usd("3040"), 7800n))).toBe("0.390");
    expect(formatUsdPerOutcome(ratio(usd("11864"), 7800n), 2)).toBe("1.52");
  });

  it("rounds where toUsdString would truncate", () => {
    const amount = usd("0.3899");
    expect(toUsdString(amount, 3)).toBe("0.389");
    expect(formatUsdPerOutcome(ratio(amount, 1n))).toBe("0.390");
  });

  it("converts to a float only for display", () => {
    expect(ratioToNumber(ratio(1n, 4n))).toBe(0.25);
  });
});
