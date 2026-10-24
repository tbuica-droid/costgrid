import { describe, expect, it } from "vitest";
import { compareBigint, nearestRank, nearestRankIndex } from "../src/stats.js";

describe("nearestRankIndex", () => {
  it("is max(1, ceil(n * p)) - 1", () => {
    expect(nearestRankIndex(100, 7, 100)).toBe(6);
    expect(nearestRankIndex(100, 50, 100)).toBe(49);
    expect(nearestRankIndex(9800, 99, 100)).toBe(9701);
    expect(nearestRankIndex(10, 95, 100)).toBe(9);
    expect(nearestRankIndex(1, 50, 100)).toBe(0);
    expect(nearestRankIndex(5, 0, 100)).toBe(0);
    expect(nearestRankIndex(5, 100, 100)).toBe(4);
  });

  it("matches the float formula wherever the float formula is exact", () => {
    for (let n = 1; n <= 2000; n++) {
      expect(nearestRankIndex(n, 95, 100)).toBe(Math.max(1, Math.ceil(0.95 * n)) - 1);
      expect(nearestRankIndex(n, 50, 100)).toBe(Math.max(1, Math.ceil(0.5 * n)) - 1);
    }
  });

  it("rejects a fraction outside [0, 1] or a non-integer length", () => {
    expect(() => nearestRankIndex(10, 101, 100)).toThrow(RangeError);
    expect(() => nearestRankIndex(10, 1, 0)).toThrow(RangeError);
    expect(() => nearestRankIndex(1.5, 1, 2)).toThrow(RangeError);
  });
});

describe("nearestRank", () => {
  it("returns an observed value", () => {
    const sorted = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n];
    expect(nearestRank(sorted, 50, 100)).toBe(5n);
    expect(nearestRank(sorted, 90, 100)).toBe(9n);
    expect(nearestRank(sorted, 95, 100)).toBe(10n);
  });

  it("refuses an empty list", () => {
    expect(() => nearestRank([], 50, 100)).toThrow(RangeError);
  });
});

describe("compareBigint", () => {
  it("sorts bigints numerically, not as strings", () => {
    expect([10n, 9n, 100n, -1n].sort(compareBigint)).toEqual([-1n, 9n, 10n, 100n]);
  });
});
