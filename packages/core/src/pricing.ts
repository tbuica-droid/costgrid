import { type Nanodollars, usd } from "./money.js";

export type Provider = "anthropic";

/**
 * Tiers are CostGrid's own classification, not a vendor concept. The routing
 * model in `routing.ts` reasons about traffic moving *between* tiers, so every
 * priced model has to land in exactly one.
 */
export type Tier = "frontier" | "mid" | "small" | "open";

export interface ModelPrice {
  readonly id: string;
  readonly displayName: string;
  readonly provider: Provider;
  readonly tier: Tier;
  /** Nanodollars per uncached input token. */
  readonly input: Nanodollars;
  /** Nanodollars per output token. Thinking tokens bill at the output rate. */
  readonly output: Nanodollars;
  /** Nanodollars per token written to the 5-minute cache (default 1.25x input). */
  readonly cacheWrite5m: Nanodollars;
  /** Nanodollars per token written to the 1-hour cache (default 2.00x input). */
  readonly cacheWrite1h: Nanodollars;
  /** Nanodollars per token served from cache (default 0.10x input). */
  readonly cacheRead: Nanodollars;
}

/**
 * Convert a "$ per million tokens" figure to exact nanodollars per token.
 *
 * Throws rather than truncating: a price that does not divide evenly would
 * silently under-bill every request against that model, which is the exact
 * class of bug this product exists to catch.
 */
export function perMTok(dollarsPerMillionTokens: string): Nanodollars {
  const nanoPerMillion = usd(dollarsPerMillionTokens);
  const perToken = nanoPerMillion / 1_000_000n;
  if (perToken * 1_000_000n !== nanoPerMillion) {
    throw new RangeError(
      `price $${dollarsPerMillionTokens}/MTok is finer than 1 nanodollar per token`,
    );
  }
  if (perToken <= 0n) {
    throw new RangeError(`price $${dollarsPerMillionTokens}/MTok rounds to zero per token`);
  }
  return perToken;
}

interface CatalogEntry {
  displayName: string;
  tier: Tier;
  input: string;
  output: string;
  /** Overrides the default 0.10x-input cache read rate. */
  cacheRead?: string;
}

/**
 * First-party Anthropic API list prices, in $ per million tokens.
 *
 * Verified against the Anthropic pricing table dated 2026-06-24. These are
 * list rates for the direct API; Bedrock and Vertex are partner-operated with
 * separate pricing and are deliberately not modelled here yet.
 *
 * A stale entry over-or-under-states a client's bill, so this table is the
 * single place prices live and `scripts/verify-pricing.ts` re-checks it.
 */
const ANTHROPIC_CATALOG: Record<string, CatalogEntry> = {
  "claude-fable-5-1": {
    displayName: "Claude Fable 5.1",
    tier: "frontier",
    input: "10.00",
    output: "50.00",
    // Documented exception: Fable 5.1 cache reads are $0.25/MTok, not 0.10x input.
    cacheRead: "0.25",
  },
  "claude-fable-5": {
    displayName: "Claude Fable 5",
    tier: "frontier",
    input: "10.00",
    output: "50.00",
  },
  "claude-opus-5": {
    displayName: "Claude Opus 5",
    tier: "frontier",
    input: "5.00",
    output: "25.00",
  },
  "claude-opus-4-8": {
    displayName: "Claude Opus 4.8",
    tier: "frontier",
    input: "5.00",
    output: "25.00",
  },
  "claude-opus-4-7": {
    displayName: "Claude Opus 4.7",
    tier: "frontier",
    input: "5.00",
    output: "25.00",
  },
  "claude-opus-4-6": {
    displayName: "Claude Opus 4.6",
    tier: "frontier",
    input: "5.00",
    output: "25.00",
  },
  "claude-sonnet-5": {
    displayName: "Claude Sonnet 5",
    tier: "mid",
    input: "2.00",
    output: "10.00",
  },
  "claude-sonnet-4-6": {
    displayName: "Claude Sonnet 4.6",
    tier: "mid",
    input: "3.00",
    output: "15.00",
  },
  "claude-haiku-4-5": {
    displayName: "Claude Haiku 4.5",
    tier: "small",
    input: "1.00",
    output: "5.00",
  },
};

function build(catalog: Record<string, CatalogEntry>, provider: Provider): Map<string, ModelPrice> {
  const priced = new Map<string, ModelPrice>();
  for (const [id, entry] of Object.entries(catalog)) {
    const input = perMTok(entry.input);
    priced.set(id, {
      id,
      displayName: entry.displayName,
      provider,
      tier: entry.tier,
      input,
      output: perMTok(entry.output),
      // 1.25x input for a 5-minute cache write; expressed as *5/4 to stay exact.
      cacheWrite5m: (input * 5n) / 4n,
      cacheWrite1h: input * 2n,
      cacheRead: entry.cacheRead === undefined ? input / 10n : perMTok(entry.cacheRead),
    });
  }
  return priced;
}

const PRICES = build(ANTHROPIC_CATALOG, "anthropic");

/** Every model CostGrid can price, in catalog order. */
export function listModelPrices(): ModelPrice[] {
  return [...PRICES.values()];
}

/**
 * Look up a model's price, or `undefined` if it is not in the catalog.
 *
 * Callers in the metering path must treat `undefined` as "record the usage,
 * flag the cost as unpriced" — never as "this request was free". A model
 * released after our last catalog refresh is the normal cause.
 */
export function findModelPrice(modelId: string): ModelPrice | undefined {
  const exact = PRICES.get(modelId);
  if (exact) return exact;

  // Anthropic accepts dated snapshot IDs (`claude-opus-5-20260401`) that price
  // identically to their base model. Match the longest catalog id that the
  // requested id extends, so `claude-opus-4-8-20260101` doesn't match `claude-opus-4`.
  let best: ModelPrice | undefined;
  for (const [id, price] of PRICES) {
    if (modelId.startsWith(`${id}-`) && (best === undefined || id.length > best.id.length)) {
      best = price;
    }
  }
  return best;
}
