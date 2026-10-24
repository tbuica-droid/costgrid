/**
 * Order statistics shared by the insight reports and the LCSO engine.
 *
 * Percentiles use the nearest-rank method: the value at rank
 * `ceil(n * p)` of the ascending list. It always returns a value that was
 * actually observed, never an interpolation, so a reported p90 cost is the
 * cost of a real task. The rank is computed with integers, because
 * `Math.ceil(0.95 * n)` in floating point can land one rank high when
 * `0.95 * n` should be a whole number and is not quite.
 */

export const compareBigint = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Zero-based index of the nearest-rank percentile `num/den` in a list of `n`:
 * `max(1, ceil(n * num / den)) - 1`.
 */
export function nearestRankIndex(n: number, num: number, den: number): number {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`list length must be a safe integer >= 0, got ${n}`);
  }
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den <= 0 || num < 0 || num > den) {
    throw new RangeError(`percentile must be an integer fraction in [0, 1], got ${num}/${den}`);
  }
  const product = BigInt(n) * BigInt(num);
  const rank = (product + BigInt(den) - 1n) / BigInt(den);
  return Math.max(1, Number(rank)) - 1;
}

/** Nearest-rank percentile `num/den` of an ascending list. */
export function nearestRank<T>(sorted: readonly T[], num: number, den: number): T {
  if (sorted.length === 0) throw new RangeError("percentile of an empty list");
  return sorted[nearestRankIndex(sorted.length, num, den)]!;
}
