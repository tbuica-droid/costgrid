import { mulDiv, type Nanodollars, usd } from "./money.js";

export type Provider = "anthropic";

/**
 * Tiers are CostGrid's own classification, not a vendor concept. The routing
 * model in `routing.ts` reasons about traffic moving *between* tiers, so every
 * priced model has to land in exactly one.
 */
export type Tier = "frontier" | "mid" | "small" | "open";

/**
 * Where the catalog's numbers came from, and when.
 *
 * A price catalog is a claim about the world that decays. Recording the source
 * and the verification date turns "trust me" into something a customer's
 * finance team can audit, and lets the product warn when it is going stale
 * rather than quietly billing against last quarter's rates.
 */
export const CATALOG_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

/** UTC date the catalog was last checked against `CATALOG_SOURCE`. */
export const CATALOG_VERIFIED_AT = "2026-09-11";

/**
 * Past this age the catalog is treated as stale and every surface says so.
 * Anthropic has repriced mid-quarter before (Sonnet 5's introductory rate
 * became standard), so a quarter is already generous.
 */
export const CATALOG_STALE_AFTER_DAYS = 45;

export function catalogAgeDays(now = new Date()): number {
  const verified = Date.parse(`${CATALOG_VERIFIED_AT}T00:00:00Z`);
  return Math.floor((now.getTime() - verified) / 86_400_000);
}

export function isCatalogStale(now = new Date()): boolean {
  return catalogAgeDays(now) > CATALOG_STALE_AFTER_DAYS;
}

export interface ModelPrice {
  readonly id: string;
  readonly displayName: string;
  readonly provider: Provider;
  readonly tier: Tier;
  /** Nanodollars per uncached input token. */
  readonly input: Nanodollars;
  /** Nanodollars per output token. Thinking tokens bill at the output rate. */
  readonly output: Nanodollars;
  /** Nanodollars per token written to the 5-minute cache (1.25x input). */
  readonly cacheWrite5m: Nanodollars;
  /** Nanodollars per token written to the 1-hour cache (2x input). */
  readonly cacheWrite1h: Nanodollars;
  /** Nanodollars per token served from cache (0.1x input, or 0.025x on Fable/Mythos 5.1). */
  readonly cacheRead: Nanodollars;
  /** Premium input rate when `speed: "fast"` is used, where the model supports it. */
  readonly fastInput?: Nanodollars;
  readonly fastOutput?: Nanodollars;
  /**
   * Retired from the first-party API. Still priced, because historical calls
   * need pricing and some retired models remain served on partner platforms.
   */
  readonly retired: boolean;
}

/**
 * Modifiers that change what a call costs without changing the model.
 *
 * Missing any of these silently misstates a bill: fast mode doubles the rate,
 * US-pinned inference adds 10%, and a batch call costs half. Both `speed` and
 * `inferenceGeo` are reported back in the response `usage`, so they are
 * observable rather than guessed.
 */
export interface PriceModifiers {
  readonly speed?: "standard" | "fast";
  readonly inferenceGeo?: "global" | "us";
  /** Submitted through the Batch API, which discounts every token category 50%. */
  readonly batch?: boolean;
}

export const NO_MODIFIERS: PriceModifiers = {};

/** The four rates a call is billed against, after modifiers. */
export interface EffectiveRates {
  readonly input: Nanodollars;
  readonly output: Nanodollars;
  readonly cacheWrite5m: Nanodollars;
  readonly cacheWrite1h: Nanodollars;
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
  /** Fast-mode input/output, where the model supports `speed: "fast"`. */
  fast?: { input: string; output: string };
  retired?: true;
}

/**
 * First-party Anthropic API list prices, in $ per million tokens.
 *
 * Verified against CATALOG_SOURCE on CATALOG_VERIFIED_AT. Partner-operated
 * platforms (Bedrock, Google Cloud) price separately and are not modelled;
 * Claude Platform on AWS and Microsoft Foundry bill these same rates through
 * Claude Consumption Units.
 *
 * `scripts/verify-pricing.mjs` re-checks every row against the live page.
 */
const ANTHROPIC_CATALOG: Record<string, CatalogEntry> = {
  // --- Fable / Mythos: above Opus, 0.025x cache reads on the 5.1 generation ---
  "claude-fable-5-1": {
    displayName: "Claude Fable 5.1",
    tier: "frontier",
    input: "10.00",
    output: "50.00",
    cacheRead: "0.25", // 0.025x, not the standard 0.1x
  },
  "claude-mythos-5-1": {
    displayName: "Claude Mythos 5.1",
    tier: "frontier",
    input: "10.00",
    output: "50.00",
    cacheRead: "0.25",
  },
  "claude-fable-5": {
    displayName: "Claude Fable 5",
    tier: "frontier",
    input: "10.00",
    output: "50.00",
  },
  "claude-mythos-5": {
    displayName: "Claude Mythos 5",
    tier: "frontier",
    input: "10.00",
    output: "50.00",
  },

  // --- Opus ---
  "claude-opus-5": {
    displayName: "Claude Opus 5",
    tier: "frontier",
    input: "5.00",
    output: "25.00",
    fast: { input: "10.00", output: "50.00" },
  },
  "claude-opus-4-8": {
    displayName: "Claude Opus 4.8",
    tier: "frontier",
    input: "5.00",
    output: "25.00",
    fast: { input: "10.00", output: "50.00" },
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
  "claude-opus-4-5": {
    displayName: "Claude Opus 4.5",
    tier: "frontier",
    input: "5.00",
    output: "25.00",
  },
  "claude-opus-4-1": {
    displayName: "Claude Opus 4.1",
    tier: "frontier",
    input: "15.00",
    output: "75.00",
    retired: true,
  },
  "claude-opus-4": {
    displayName: "Claude Opus 4",
    tier: "frontier",
    input: "15.00",
    output: "75.00",
    retired: true,
  },

  // --- Sonnet ---
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
  "claude-sonnet-4-5": {
    displayName: "Claude Sonnet 4.5",
    tier: "mid",
    input: "3.00",
    output: "15.00",
  },
  "claude-sonnet-4": {
    displayName: "Claude Sonnet 4",
    tier: "mid",
    input: "3.00",
    output: "15.00",
    retired: true,
  },

  // --- Haiku ---
  "claude-haiku-4-5": {
    displayName: "Claude Haiku 4.5",
    tier: "small",
    input: "1.00",
    output: "5.00",
  },
  "claude-haiku-3-5": {
    displayName: "Claude Haiku 3.5",
    tier: "small",
    input: "0.80",
    output: "4.00",
    retired: true,
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
      cacheWrite5m: mulDiv(input, 5n, 4n),
      cacheWrite1h: input * 2n,
      cacheRead: entry.cacheRead === undefined ? mulDiv(input, 1n, 10n) : perMTok(entry.cacheRead),
      ...(entry.fast
        ? { fastInput: perMTok(entry.fast.input), fastOutput: perMTok(entry.fast.output) }
        : {}),
      retired: entry.retired ?? false,
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

/**
 * Apply pricing modifiers to a model's list rates.
 *
 * Order matters and follows the published stacking rules: fast mode replaces
 * the base rates, cache multipliers derive from whichever input rate is in
 * effect, then data residency and the batch discount scale everything.
 */
export function effectiveRates(
  price: ModelPrice,
  modifiers: PriceModifiers = NO_MODIFIERS,
): EffectiveRates {
  // Fast mode is only defined for models that support it; asking for it on
  // any other model bills at standard rates, which is what the API does.
  const fast = modifiers.speed === "fast" && price.fastInput !== undefined;
  const input = fast ? price.fastInput! : price.input;
  const output = fast ? price.fastOutput! : price.output;

  // Cache rates are multiples of the *effective* input rate, so they inherit
  // fast-mode pricing rather than staying at the standard-rate multiple.
  const isReducedCacheRead = price.cacheRead * 10n !== price.input;
  let rates: EffectiveRates = {
    input,
    output,
    cacheWrite5m: mulDiv(input, 5n, 4n),
    cacheWrite1h: input * 2n,
    cacheRead: isReducedCacheRead ? mulDiv(input, 1n, 40n) : mulDiv(input, 1n, 10n),
  };

  const scale = (numerator: bigint, denominator: bigint): EffectiveRates => ({
    input: mulDiv(rates.input, numerator, denominator),
    output: mulDiv(rates.output, numerator, denominator),
    cacheWrite5m: mulDiv(rates.cacheWrite5m, numerator, denominator),
    cacheWrite1h: mulDiv(rates.cacheWrite1h, numerator, denominator),
    cacheRead: mulDiv(rates.cacheRead, numerator, denominator),
  });

  if (modifiers.inferenceGeo === "us") rates = scale(11n, 10n);
  if (modifiers.batch === true) rates = scale(1n, 2n);

  return rates;
}
