import { type Nanodollars } from "./money.js";
import { findModelPrice, type ModelPrice } from "./pricing.js";

/**
 * Token counts for one completed call, normalised from a provider's `usage`
 * object. All four buckets bill at different rates, which is precisely why
 * a provider invoice total cannot be attributed back to an agent.
 */
export interface TokenUsage {
  /** Uncached input tokens. Anthropic reports cached tokens separately, not inside this. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens written to the 5-minute ephemeral cache. Billed above the input rate. */
  readonly cacheWrite5mTokens: number;
  /** Tokens written to the 1-hour ephemeral cache. */
  readonly cacheWrite1hTokens: number;
  /** Tokens served from cache. Billed far below the input rate. */
  readonly cacheReadTokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
};

/** The cost of one call, broken out so a bill can be explained rather than asserted. */
export interface CostBreakdown {
  readonly input: Nanodollars;
  readonly output: Nanodollars;
  readonly cacheWrite: Nanodollars;
  readonly cacheRead: Nanodollars;
  readonly total: Nanodollars;
}

export const ZERO_COST: CostBreakdown = {
  input: 0n,
  output: 0n,
  cacheWrite: 0n,
  cacheRead: 0n,
  total: 0n,
};

export interface PricedUsage {
  readonly usage: TokenUsage;
  readonly cost: CostBreakdown;
  /**
   * The catalog entry used. `undefined` means the model is unknown to us: the
   * usage is still recorded truthfully, but `cost` is zero and the call MUST be
   * persisted with `priced: false` so it shows as unpriced rather than free.
   */
  readonly price: ModelPrice | undefined;
  readonly priced: boolean;
}

function readCount(source: Record<string, unknown>, key: string): number {
  const raw = source[key];
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new TypeError(`usage.${key} is not a finite number: ${JSON.stringify(raw)}`);
  }
  if (raw < 0 || !Number.isInteger(raw)) {
    throw new RangeError(`usage.${key} is not a non-negative integer: ${raw}`);
  }
  return raw;
}

/**
 * Normalise an Anthropic Messages API `usage` object.
 *
 * Handles both cache-write shapes: the flat `cache_creation_input_tokens`
 * scalar, and the newer `cache_creation` object that splits 5-minute from
 * 1-hour writes. When both are present the object wins, because it is the
 * more specific breakdown of the same total.
 *
 * This is a trust boundary — the object arrives over the wire — so every field
 * is validated rather than coerced.
 */
export function parseAnthropicUsage(raw: unknown): TokenUsage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`usage is not an object: ${JSON.stringify(raw)}`);
  }
  const usage = raw as Record<string, unknown>;

  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  const creation = usage["cache_creation"];
  if (typeof creation === "object" && creation !== null && !Array.isArray(creation)) {
    const detail = creation as Record<string, unknown>;
    cacheWrite5m = readCount(detail, "ephemeral_5m_input_tokens");
    cacheWrite1h = readCount(detail, "ephemeral_1h_input_tokens");
  } else {
    cacheWrite5m = readCount(usage, "cache_creation_input_tokens");
  }

  return {
    inputTokens: readCount(usage, "input_tokens"),
    outputTokens: readCount(usage, "output_tokens"),
    cacheWrite5mTokens: cacheWrite5m,
    cacheWrite1hTokens: cacheWrite1h,
    cacheReadTokens: readCount(usage, "cache_read_input_tokens"),
  };
}

/**
 * Parse a usage object that may report only some fields, as streaming events do.
 *
 * Absent keys come back absent rather than zero. That distinction matters:
 * `message_delta` reports only `output_tokens`, and folding it in as a full
 * record — with implicit zeros — would erase the input and cache counts that
 * `message_start` already established.
 */
export function parsePartialAnthropicUsage(raw: unknown): Partial<TokenUsage> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`usage is not an object: ${JSON.stringify(raw)}`);
  }
  const usage = raw as Record<string, unknown>;
  const partial: Record<string, number> = {};

  if (usage["input_tokens"] != null) partial["inputTokens"] = readCount(usage, "input_tokens");
  if (usage["output_tokens"] != null) partial["outputTokens"] = readCount(usage, "output_tokens");
  if (usage["cache_read_input_tokens"] != null) {
    partial["cacheReadTokens"] = readCount(usage, "cache_read_input_tokens");
  }

  const creation = usage["cache_creation"];
  if (typeof creation === "object" && creation !== null && !Array.isArray(creation)) {
    const detail = creation as Record<string, unknown>;
    partial["cacheWrite5mTokens"] = readCount(detail, "ephemeral_5m_input_tokens");
    partial["cacheWrite1hTokens"] = readCount(detail, "ephemeral_1h_input_tokens");
  } else if (usage["cache_creation_input_tokens"] != null) {
    partial["cacheWrite5mTokens"] = readCount(usage, "cache_creation_input_tokens");
  }

  return partial as Partial<TokenUsage>;
}

/**
 * Overlay the fields a partial record actually provides.
 *
 * Streaming `output_tokens` is cumulative, not incremental, so the correct
 * fold is replacement of present fields — not addition.
 */
export function overlayUsage(base: TokenUsage, patch: Partial<TokenUsage>): TokenUsage {
  return { ...base, ...patch };
}

/** Merge two usage records. Used to fold streaming deltas into a running total. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

/** Total billable tokens, for the useful-token-ratio and volume metrics. */
export function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheWrite5mTokens +
    usage.cacheWrite1hTokens +
    usage.cacheReadTokens
  );
}

export function costOf(usage: TokenUsage, price: ModelPrice): CostBreakdown {
  const input = BigInt(usage.inputTokens) * price.input;
  const output = BigInt(usage.outputTokens) * price.output;
  const cacheWrite =
    BigInt(usage.cacheWrite5mTokens) * price.cacheWrite5m +
    BigInt(usage.cacheWrite1hTokens) * price.cacheWrite1h;
  const cacheRead = BigInt(usage.cacheReadTokens) * price.cacheRead;

  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

/**
 * Price a call. An unknown model yields zero cost with `priced: false` — the
 * caller is responsible for surfacing that, never for treating it as free.
 */
export function priceUsage(modelId: string, usage: TokenUsage): PricedUsage {
  const price = findModelPrice(modelId);
  if (!price) return { usage, cost: ZERO_COST, price: undefined, priced: false };
  return { usage, cost: costOf(usage, price), price, priced: true };
}
