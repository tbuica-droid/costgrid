import { mulDiv, type Nanodollars, usd } from "./money.js";

/**
 * A billing channel, not a model family.
 *
 * Bedrock and Vertex serve the same Claude models as Anthropic direct, but
 * they are separate providers here because they bill separately, hold separate
 * credentials, and must never be routed across: a Bedrock model id is not
 * valid on the Anthropic API, so rewriting one into the other would send a
 * malformed request upstream.
 */
export type Provider = "anthropic" | "openai" | "bedrock" | "vertex";

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
export interface CatalogProvenance {
  readonly provider: Provider;
  readonly source: string;
  /** UTC date this provider's prices were last checked against `source`. */
  readonly verifiedAt: string;
}

export const CATALOG_PROVENANCE: readonly CatalogProvenance[] = [
  {
    provider: "anthropic",
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    verifiedAt: "2026-09-11",
  },
  {
    provider: "openai",
    source: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-09-11",
  },
];

/** The oldest verification date across providers — the catalog is only as fresh as its stalest half. */
export const CATALOG_VERIFIED_AT = CATALOG_PROVENANCE.reduce(
  (oldest, p) => (p.verifiedAt < oldest ? p.verifiedAt : oldest),
  CATALOG_PROVENANCE[0]!.verifiedAt,
);

/** Kept for callers that predate multi-provider; prefer CATALOG_PROVENANCE. */
export const CATALOG_SOURCE = CATALOG_PROVENANCE[0]!.source;

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
   * Rates that apply once a request's context exceeds `thresholdTokens`.
   *
   * OpenAI's newest models bill roughly double above 272K context. Ignoring
   * this understates every large-context call by half.
   */
  readonly longContext?: LongContextRates;
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

export interface LongContextRates {
  readonly thresholdTokens: number;
  readonly input: Nanodollars;
  readonly output: Nanodollars;
  readonly cacheWrite5m: Nanodollars;
  readonly cacheWrite1h: Nanodollars;
  readonly cacheRead: Nanodollars;
}

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
  /** Explicit cache-write rate, where the provider publishes one. */
  cacheWrite?: string;
  /** Fast-mode input/output, where the model supports `speed: "fast"`. */
  fast?: { input: string; output: string };
  /** Rates above the long-context threshold, where the provider has two tiers. */
  long?: { input: string; output: string; cacheRead?: string; cacheWrite?: string };
  retired?: true;
}

/**
 * Context size above which OpenAI's long-context rates apply.
 *
 * Published as "(<272K context length)" on the rows that annotate it. The
 * gpt-6 and gpt-5.6 families publish long-context columns without restating
 * the threshold; 272K is assumed for them, which is the only figure OpenAI
 * documents. If that assumption is wrong the error is bounded — it shifts
 * where the 2x step happens, not whether large calls are billed at 2x.
 */
const OPENAI_LONG_CONTEXT_THRESHOLD = 272_000;

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

/**
 * OpenAI API list prices, in $ per million tokens.
 *
 * Two structural differences from Anthropic, both of which change the maths:
 *
 *   1. Cache reads have a *published per-model rate* rather than a fixed
 *      multiple of input. gpt-4o reads at 0.5x, gpt-5 at 0.1x, o3-mini at
 *      0.5x — assuming one multiplier would misprice most of the table.
 *   2. There is no separate cache-*write* charge. Writes bill at the ordinary
 *      input rate, so cacheWrite5m/1h are set equal to input rather than
 *      marked up.
 *
 * Models with no published cached rate (the -pro tier) do not support caching;
 * their cacheRead is set to the input rate so a stray cached token cannot be
 * billed at a discount we have not verified.
 */
const OPENAI_CATALOG: Record<string, CatalogEntry> = {
  // --- Current generation. These publish a separate cache-write rate and a
  // --- long-context tier; earlier families do neither.
  "gpt-6-astra": {
    displayName: "GPT-6 Astra", tier: "frontier",
    input: "10.00", output: "50.00", cacheRead: "1.00", cacheWrite: "12.50",
    long: { input: "20.00", output: "75.00", cacheRead: "2.00", cacheWrite: "25.00" },
  },
  "gpt-5.6-sol": {
    displayName: "GPT-5.6 Sol", tier: "frontier",
    input: "4.00", output: "20.00", cacheRead: "0.40", cacheWrite: "5.00",
    long: { input: "8.00", output: "30.00", cacheRead: "0.80", cacheWrite: "10.00" },
  },
  "gpt-5.6-terra": {
    displayName: "GPT-5.6 Terra", tier: "mid",
    input: "2.00", output: "12.00", cacheRead: "0.20", cacheWrite: "2.50",
    long: { input: "4.00", output: "18.00", cacheRead: "0.40", cacheWrite: "5.00" },
  },
  "gpt-5.6-luna": {
    displayName: "GPT-5.6 Luna", tier: "small",
    input: "0.20", output: "1.20", cacheRead: "0.02", cacheWrite: "0.25",
    long: { input: "0.40", output: "1.80", cacheRead: "0.04", cacheWrite: "0.50" },
  },

  "gpt-5.5": {
    displayName: "GPT-5.5", tier: "frontier",
    input: "5.00", output: "30.00", cacheRead: "0.50",
    long: { input: "10.00", output: "45.00", cacheRead: "1.00" },
  },
  "gpt-5.5-pro": {
    displayName: "GPT-5.5 pro", tier: "frontier",
    input: "30.00", output: "180.00",
    long: { input: "60.00", output: "270.00" },
  },
  "gpt-5.4": {
    displayName: "GPT-5.4", tier: "mid",
    input: "2.50", output: "15.00", cacheRead: "0.25",
    long: { input: "5.00", output: "22.50", cacheRead: "0.50" },
  },
  "gpt-5.4-mini": { displayName: "GPT-5.4 mini", tier: "small", input: "0.75", output: "4.50", cacheRead: "0.075" },
  "gpt-5.4-nano": { displayName: "GPT-5.4 nano", tier: "small", input: "0.20", output: "1.25", cacheRead: "0.02" },
  "gpt-5.4-pro": {
    displayName: "GPT-5.4 pro", tier: "frontier",
    input: "30.00", output: "180.00",
    long: { input: "60.00", output: "270.00" },
  },

  "gpt-5.2": { displayName: "GPT-5.2", tier: "mid", input: "1.75", output: "14.00", cacheRead: "0.175" },
  "gpt-5.2-pro": { displayName: "GPT-5.2 pro", tier: "frontier", input: "21.00", output: "168.00" },
  "gpt-5.1": { displayName: "GPT-5.1", tier: "mid", input: "1.25", output: "10.00", cacheRead: "0.125" },

  "gpt-5": { displayName: "GPT-5", tier: "mid", input: "1.25", output: "10.00", cacheRead: "0.125" },
  "gpt-5-mini": { displayName: "GPT-5 mini", tier: "small", input: "0.25", output: "2.00", cacheRead: "0.025" },
  "gpt-5-nano": { displayName: "GPT-5 nano", tier: "small", input: "0.05", output: "0.40", cacheRead: "0.005" },
  "gpt-5-pro": { displayName: "GPT-5 pro", tier: "frontier", input: "15.00", output: "120.00" },

  "gpt-4.1": { displayName: "GPT-4.1", tier: "mid", input: "2.00", output: "8.00", cacheRead: "0.50" },
  "gpt-4.1-mini": { displayName: "GPT-4.1 mini", tier: "small", input: "0.40", output: "1.60", cacheRead: "0.10" },
  "gpt-4.1-nano": { displayName: "GPT-4.1 nano", tier: "small", input: "0.10", output: "0.40", cacheRead: "0.025" },

  "gpt-4o": { displayName: "GPT-4o", tier: "mid", input: "2.50", output: "10.00", cacheRead: "1.25" },
  // Priced differently from the gpt-4o alias, so it is listed explicitly —
  // an exact id match beats the longest-prefix fallback.
  "gpt-4o-2024-05-13": { displayName: "GPT-4o (2024-05-13)", tier: "mid", input: "5.00", output: "15.00" },
  "gpt-4o-mini": { displayName: "GPT-4o mini", tier: "small", input: "0.15", output: "0.60", cacheRead: "0.075" },

  "o1": { displayName: "o1", tier: "frontier", input: "15.00", output: "60.00", cacheRead: "7.50" },
  "o1-pro": { displayName: "o1-pro", tier: "frontier", input: "150.00", output: "600.00" },
  "o3": { displayName: "o3", tier: "mid", input: "2.00", output: "8.00", cacheRead: "0.50" },
  "o3-pro": { displayName: "o3-pro", tier: "frontier", input: "20.00", output: "80.00" },
  "o3-mini": { displayName: "o3-mini", tier: "small", input: "1.10", output: "4.40", cacheRead: "0.55" },
  "o4-mini": { displayName: "o4-mini", tier: "small", input: "1.10", output: "4.40", cacheRead: "0.275" },

  // --- Legacy, still served. Catalogued so their calls price rather than
  // --- landing in the unpriced bucket.
  "gpt-4-turbo-2024-04-09": { displayName: "GPT-4 Turbo", tier: "mid", input: "10.00", output: "30.00", retired: true },
  "gpt-4-0613": { displayName: "GPT-4 (0613)", tier: "mid", input: "30.00", output: "60.00", retired: true },
  "gpt-3.5-turbo": { displayName: "GPT-3.5 Turbo", tier: "small", input: "0.50", output: "1.50", retired: true },
  "gpt-3.5-turbo-1106": { displayName: "GPT-3.5 Turbo (1106)", tier: "small", input: "1.00", output: "2.00", retired: true },
  "gpt-3.5-turbo-instruct": { displayName: "GPT-3.5 Turbo Instruct", tier: "small", input: "1.50", output: "2.00", retired: true },
  "davinci-002": { displayName: "davinci-002", tier: "small", input: "2.00", output: "2.00", retired: true },
  "babbage-002": { displayName: "babbage-002", tier: "small", input: "0.40", output: "0.40", retired: true },
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
      // Anthropic derives cache writes from input (1.25x / 2x). OpenAI's
      // newest models publish an explicit write rate; older ones bill a write
      // as an ordinary input token.
      cacheWrite5m:
        entry.cacheWrite !== undefined
          ? perMTok(entry.cacheWrite)
          : provider === "anthropic"
            ? mulDiv(input, 5n, 4n)
            : input,
      cacheWrite1h:
        entry.cacheWrite !== undefined
          ? perMTok(entry.cacheWrite)
          : provider === "anthropic"
            ? input * 2n
            : input,
      // A model with no published cached rate does not support caching; its
      // read rate is the input rate, so a stray cached token cannot be given
      // a discount we have not verified.
      cacheRead:
        entry.cacheRead !== undefined
          ? perMTok(entry.cacheRead)
          : provider === "anthropic"
            ? mulDiv(input, 1n, 10n)
            : input,
      ...(entry.long
        ? {
            longContext: {
              thresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD,
              input: perMTok(entry.long.input),
              output: perMTok(entry.long.output),
              cacheWrite5m:
                entry.long.cacheWrite !== undefined
                  ? perMTok(entry.long.cacheWrite)
                  : perMTok(entry.long.input),
              cacheWrite1h:
                entry.long.cacheWrite !== undefined
                  ? perMTok(entry.long.cacheWrite)
                  : perMTok(entry.long.input),
              cacheRead:
                entry.long.cacheRead !== undefined
                  ? perMTok(entry.long.cacheRead)
                  : perMTok(entry.long.input),
            },
          }
        : {}),
      ...(entry.fast
        ? { fastInput: perMTok(entry.fast.input), fastOutput: perMTok(entry.fast.output) }
        : {}),
      retired: entry.retired ?? false,
    });
  }
  return priced;
}

const PRICES = new Map<string, ModelPrice>([
  ...build(ANTHROPIC_CATALOG, "anthropic"),
  ...build(OPENAI_CATALOG, "openai"),
]);

/** Every model CostGrid can price, in catalog order. */
export function listModelPrices(provider?: Provider): ModelPrice[] {
  const all = [...PRICES.values()];
  return provider === undefined ? all : all.filter((m) => m.provider === provider);
}

/**
 * Look up a model's price, or `undefined` if it is not in the catalog.
 *
 * Callers in the metering path must treat `undefined` as "record the usage,
 * flag the cost as unpriced" — never as "this request was free". A model
 * released after our last catalog refresh is the normal cause.
 */
/**
 * Strip a channel's packaging from a model id.
 *
 * The same model reaches a customer under three spellings:
 *
 *   anthropic direct  claude-opus-4-5-20260101
 *   bedrock           anthropic.claude-opus-4-5-20260101-v1:0
 *   bedrock, routed   us.anthropic.claude-opus-4-5-20260101-v1:0
 *   vertex            claude-opus-4-5@20260101
 *
 * The rates are looked up under the first. Normalising here means the catalog
 * stays one table rather than three that must be kept in step — and a model
 * priced correctly on one channel cannot silently become unpriced on another.
 *
 * Channel *prices* do differ, and this function does not pretend otherwise;
 * see `CHANNEL_PRICING_NOTE`.
 */
export function normaliseModelId(modelId: string): string {
  let id = modelId.trim();

  // Bedrock cross-region inference profiles prefix a geography.
  id = id.replace(/^(us|eu|apac|us-gov)\./, "");
  // Bedrock namespaces by vendor and suffixes a version.
  id = id.replace(/^(anthropic|meta|mistral|amazon|cohere|ai21)\./, "");
  id = id.replace(/-v\d+:\d+$/, "");
  // Vertex separates the snapshot date with @ rather than a hyphen.
  id = id.replace(/@(\d{8})$/, "-$1");

  return id;
}

/**
 * What to tell an operator whose traffic arrives through Bedrock or Vertex.
 *
 * Those channels publish their own per-region rates, which this catalog does
 * not carry and cannot verify. Traffic is priced at the direct-API list rate
 * for the same model, which is close but not exact. `costgrid rates derive`
 * against the AWS or GCP invoice turns close into exact.
 */
export const CHANNEL_PRICING_NOTE =
  "Bedrock and Vertex traffic is priced at the direct-API list rate for the same model. " +
  "Their published rates differ by channel and region, so derive your actual rate from an " +
  "invoice: costgrid rates derive <provider> --invoiced <usd>.";

export function findModelPrice(modelId: string): ModelPrice | undefined {
  const exact = PRICES.get(modelId);
  if (exact) return exact;

  const normalised = normaliseModelId(modelId);
  if (normalised !== modelId) {
    const viaChannel = findModelPrice(normalised);
    if (viaChannel) return viaChannel;
  }

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
  contextTokens = 0,
): EffectiveRates {
  // A request past the long-context threshold bills at the higher tier across
  // every category. Checked first, because it replaces the base rates the
  // rest of this function derives from.
  if (price.longContext !== undefined && contextTokens > price.longContext.thresholdTokens) {
    return scaleRates(price.longContext, modifiers);
  }
  // Fast mode is only defined for models that support it; asking for it on
  // any other model bills at standard rates, which is what the API does.
  const fast = modifiers.speed === "fast" && price.fastInput !== undefined;
  const input = fast ? price.fastInput! : price.input;
  const output = fast ? price.fastOutput! : price.output;

  // Cache rates are multiples of the *effective* input rate, so on Anthropic
  // they inherit fast-mode pricing rather than staying at the standard-rate
  // multiple. OpenAI publishes a per-model cache rate and has no fast mode, so
  // its rates are carried through as catalogued.
  let rates: EffectiveRates;
  if (price.provider === "anthropic") {
    const isReducedCacheRead = price.cacheRead * 10n !== price.input;
    rates = {
      input,
      output,
      cacheWrite5m: mulDiv(input, 5n, 4n),
      cacheWrite1h: input * 2n,
      cacheRead: isReducedCacheRead ? mulDiv(input, 1n, 40n) : mulDiv(input, 1n, 10n),
    };
  } else {
    rates = {
      input,
      output,
      cacheWrite5m: price.cacheWrite5m,
      cacheWrite1h: price.cacheWrite1h,
      cacheRead: price.cacheRead,
    };
  }

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

/** Apply the provider-independent modifiers to an already-chosen rate set. */
function scaleRates(base: EffectiveRates, modifiers: PriceModifiers): EffectiveRates {
  const factor = (numerator: bigint, denominator: bigint, rates: EffectiveRates): EffectiveRates => ({
    input: mulDiv(rates.input, numerator, denominator),
    output: mulDiv(rates.output, numerator, denominator),
    cacheWrite5m: mulDiv(rates.cacheWrite5m, numerator, denominator),
    cacheWrite1h: mulDiv(rates.cacheWrite1h, numerator, denominator),
    cacheRead: mulDiv(rates.cacheRead, numerator, denominator),
  });

  let rates: EffectiveRates = {
    input: base.input,
    output: base.output,
    cacheWrite5m: base.cacheWrite5m,
    cacheWrite1h: base.cacheWrite1h,
    cacheRead: base.cacheRead,
  };
  if (modifiers.inferenceGeo === "us") rates = factor(11n, 10n, rates);
  if (modifiers.batch === true) rates = factor(1n, 2n, rates);
  return rates;
}
