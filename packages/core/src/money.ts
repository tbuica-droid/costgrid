/**
 * Money in CostGrid is always an exact integer count of *nanodollars*
 * (1 USD = 1_000_000_000n nano), carried as a `bigint`.
 *
 * Rationale: this is a FinOps product, so a cent of drift is a bug report.
 * Token prices routinely have six decimal places ($0.000435/token), and
 * IEEE-754 doubles cannot represent those exactly — summing a million
 * float-priced requests accumulates visible error. Integer nanodollars
 * make every arithmetic operation in the billing path exact, and `bigint`
 * removes the 2^53 ceiling that would otherwise cap an aggregate at ~$9M.
 *
 * Conversion to `number` happens only at the presentation edge.
 */

/** Exact integer nanodollars. 1 USD = 1e9. */
export type Nanodollars = bigint;

export const NANO_PER_USD = 1_000_000_000n;
export const NANO_PER_CENT = 10_000_000n;

/**
 * Parse a decimal USD string or number into exact nanodollars.
 *
 * Accepts at most 9 decimal places. A `number` input is stringified first,
 * so `usd(0.1)` is exactly 100_000_000n rather than the float's 0.1000000000000000055.
 */
export function usd(amount: string | number): Nanodollars {
  const text = typeof amount === "number" ? formatNumberForParse(amount) : amount.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError(`not a decimal USD amount: ${JSON.stringify(amount)}`);

  const [, sign, whole = "0", fraction = ""] = match;
  if (fraction.length > 9) {
    throw new RangeError(`USD amount has more than 9 decimal places: ${text}`);
  }
  const scaled = BigInt(whole) * NANO_PER_USD + BigInt(fraction.padEnd(9, "0") || "0");
  return sign === "-" ? -scaled : scaled;
}

function formatNumberForParse(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`USD amount is not finite: ${value}`);
  // toFixed(9) matches the nanodollar resolution and avoids exponential notation
  // for the small magnitudes (1e-7 and below) that token prices reach.
  return value.toFixed(9);
}

/** Format nanodollars as a plain decimal USD string, e.g. "12.345678900". */
export function toUsdString(amount: Nanodollars, decimals = 9): string {
  if (decimals < 0 || decimals > 9) throw new RangeError(`decimals must be 0..9, got ${decimals}`);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;

  const whole = abs / NANO_PER_USD;
  const fraction = (abs % NANO_PER_USD).toString().padStart(9, "0");
  const rendered = decimals === 0 ? `${whole}` : `${whole}.${fraction.slice(0, decimals)}`;
  return negative ? `-${rendered}` : rendered;
}

/**
 * Lossy conversion to a float dollar amount, for display and charting only.
 * Never feed the result back into the billing path.
 */
export function toUsdNumber(amount: Nanodollars): number {
  return Number(amount) / 1e9;
}

/**
 * Multiply by a rational factor, rounding half away from zero.
 *
 * Pricing modifiers are rationals (1.1x data residency, 0.5x batch, 1.25x
 * cache write), and `bigint` division truncates toward zero — which would
 * under-bill by a fraction of a nanodollar on every rate that does not divide
 * evenly, systematically and always in the customer's favour. Rounding is the
 * honest choice, and it keeps the error unbiased.
 */
export function mulDiv(value: Nanodollars, numerator: bigint, denominator: bigint): Nanodollars {
  if (denominator === 0n) throw new RangeError("division by zero");

  const negative = value < 0n !== numerator < 0n !== denominator < 0n;
  const absValue = value < 0n ? -value : value;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const scaled = absValue * absNum;
  const quotient = scaled / absDen;
  const remainder = scaled % absDen;
  const rounded = remainder * 2n >= absDen ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
}

export function sumNano(amounts: Iterable<Nanodollars>): Nanodollars {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return total;
}
