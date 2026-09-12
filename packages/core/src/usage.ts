import { type Nanodollars } from "./money.js";
import {
  effectiveRates,
  findModelPrice,
  type ModelPrice,
  NO_MODIFIERS,
  type PriceModifiers,
} from "./pricing.js";

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
  /** The modifiers applied, so a bill can be explained rather than asserted. */
  readonly modifiers: PriceModifiers;
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
 * Normalise an OpenAI `usage` object, from either Chat Completions or Responses.
 *
 * The load-bearing difference from Anthropic: **OpenAI's prompt/input token
 * count is the total and *includes* cached tokens**, whereas Anthropic reports
 * them as disjoint buckets. Copying the Anthropic parser would bill every
 * cached token twice — once at the full input rate and once at the cache rate.
 * Uncached input is therefore `prompt_tokens - cached_tokens - cache_write_tokens`.
 *
 * Reasoning tokens (`completion_tokens_details.reasoning_tokens`) are already
 * included in `completion_tokens` and bill at the output rate, so they are not
 * added again — they are visible in the response but not a separate charge.
 */
export function parseOpenAiUsage(raw: unknown): TokenUsage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`usage is not an object: ${JSON.stringify(raw)}`);
  }
  const usage = raw as Record<string, unknown>;

  // Chat Completions says prompt/completion; Responses says input/output.
  const promptTotal =
    usage["prompt_tokens"] != null
      ? readCount(usage, "prompt_tokens")
      : readCount(usage, "input_tokens");
  const outputTokens =
    usage["completion_tokens"] != null
      ? readCount(usage, "completion_tokens")
      : readCount(usage, "output_tokens");

  const details = (usage["prompt_tokens_details"] ?? usage["input_tokens_details"]) as unknown;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    const d = details as Record<string, unknown>;
    cacheReadTokens = readCount(d, "cached_tokens");
    cacheWriteTokens = readCount(d, "cache_write_tokens");
  }

  const uncachedInput = promptTotal - cacheReadTokens - cacheWriteTokens;
  if (uncachedInput < 0) {
    throw new RangeError(
      `usage reports ${cacheReadTokens + cacheWriteTokens} cached tokens but only ` +
        `${promptTotal} prompt tokens — the totals are inconsistent`,
    );
  }

  return {
    inputTokens: uncachedInput,
    outputTokens,
    // OpenAI does not price 5m/1h cache writes separately; a write is an
    // ordinary input token, and the catalog rates reflect that.
    cacheWrite5mTokens: cacheWriteTokens,
    cacheWrite1hTokens: 0,
    cacheReadTokens,
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

export function costOf(
  usage: TokenUsage,
  price: ModelPrice,
  modifiers: PriceModifiers = NO_MODIFIERS,
): CostBreakdown {
  // Context size decides the long-context tier: every input token the model
  // had to read, cached or not.
  const contextTokens =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  const rates = effectiveRates(price, modifiers, contextTokens);

  const input = BigInt(usage.inputTokens) * rates.input;
  const output = BigInt(usage.outputTokens) * rates.output;
  const cacheWrite =
    BigInt(usage.cacheWrite5mTokens) * rates.cacheWrite5m +
    BigInt(usage.cacheWrite1hTokens) * rates.cacheWrite1h;
  const cacheRead = BigInt(usage.cacheReadTokens) * rates.cacheRead;

  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

/**
 * Price a call. An unknown model yields zero cost with `priced: false` — the
 * caller is responsible for surfacing that, never for treating it as free.
 */
export function priceUsage(
  modelId: string,
  usage: TokenUsage,
  modifiers: PriceModifiers = NO_MODIFIERS,
): PricedUsage {
  const price = findModelPrice(modelId);
  if (!price) {
    return { usage, cost: ZERO_COST, price: undefined, priced: false, modifiers };
  }
  return { usage, cost: costOf(usage, price, modifiers), price, priced: true, modifiers };
}

/**
 * What a call would have cost on a different model, given the same tokens.
 *
 * This is how a realised saving is measured: price the observed usage at the
 * model the caller originally asked for, and subtract what was actually paid.
 *
 * It is an **estimate**, and the reason matters. Token counts are not
 * invariant across models — different tokenizers produce different counts for
 * the same text (Anthropic documents ~30% more on 4.7 and later), and a
 * smaller model is often more verbose. So the counterfactual assumes the same
 * token counts, which is the only assumption available without running the
 * prompt twice. Every surface that shows this number calls it an estimate.
 *
 * Returns `undefined` when either model is unpriceable, rather than a
 * confident zero.
 */
export function estimateSaving(
  requestedModel: string,
  servedModel: string,
  usage: TokenUsage,
  modifiers: PriceModifiers = NO_MODIFIERS,
): Nanodollars | undefined {
  const counterfactual = priceUsage(requestedModel, usage, modifiers);
  const actual = priceUsage(servedModel, usage, modifiers);
  if (!counterfactual.priced || !actual.priced) return undefined;

  // Signed: a route that costs more must show as a loss, not be clamped to
  // zero. A savings figure that can only go up is a marketing number.
  return counterfactual.cost.total - actual.cost.total;
}

/**
 * Read the pricing modifiers a provider reports back on a completed call.
 *
 * `usage.speed` and `usage.inference_geo` are how the API tells you what it
 * actually charged for — a fast-mode call bills at double, a US-pinned one at
 * 1.1x. Reading them from the response rather than inferring from the request
 * means a server-side change of plan is billed correctly.
 */
export function parseAnthropicModifiers(raw: unknown): PriceModifiers {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NO_MODIFIERS;
  const usage = raw as Record<string, unknown>;

  const modifiers: { speed?: "standard" | "fast"; inferenceGeo?: "global" | "us" } = {};
  if (usage["speed"] === "fast" || usage["speed"] === "standard") {
    modifiers.speed = usage["speed"];
  }
  if (usage["inference_geo"] === "us" || usage["inference_geo"] === "global") {
    modifiers.inferenceGeo = usage["inference_geo"];
  }
  return modifiers;
}
