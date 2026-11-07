import { mulDiv, type Nanodollars } from "./money.js";
import type { CostBreakdown, TokenUsage } from "./usage.js";

/**
 * Open models, served by an endpoint the owner connects: any service that
 * accepts OpenAI-format requests, hosted or running on their own machine.
 *
 * A model on an endpoint is named `open:<endpoint>/<model>`, so the same open
 * model at two hosts is two models with two prices. Prices are the owner's,
 * entered per endpoint with where they came from and when: hosts differ and
 * reprice often, and a built-in figure nobody can check is exactly the decay
 * the catalog's provenance rule exists to prevent.
 *
 * Prices are whole nanodollars per million tokens ($0.88 per million is
 * 880,000,000), so a price finer than a nanodollar per token is still exact.
 * Each bucket is rounded once, half away from zero.
 */

export const OPEN_PREFIX = "open:";

export interface OpenModelPrice {
  readonly inputPerM: Nanodollars;
  readonly outputPerM: Nanodollars;
  /** Cached input, where the host discounts it; otherwise cached tokens bill as input. */
  readonly cachedInputPerM?: Nanodollars | undefined;
}

export function isOpenModel(model: string): boolean {
  return model.startsWith(OPEN_PREFIX);
}

/** `open:together/meta-llama/Llama-3.3-70B` → endpoint `together`, model `meta-llama/Llama-3.3-70B`. */
export function parseOpenModel(id: string): { endpoint: string; model: string } | undefined {
  if (!isOpenModel(id)) return undefined;
  const rest = id.slice(OPEN_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { endpoint: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

export function openModelId(endpoint: string, model: string): string {
  return `${OPEN_PREFIX}${endpoint}/${model}`;
}

/** An endpoint id: lower-case letters, digits and hyphens, as in a URL. */
export const ENDPOINT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const MILLION = 1_000_000n;

/**
 * What a call to an open model cost. Hosts charge nothing to write a cache,
 * so written tokens bill as plain input.
 */
export function costOfOpen(usage: TokenUsage, price: OpenModelPrice): CostBreakdown {
  const per = (tokens: number, perM: Nanodollars) => mulDiv(BigInt(tokens), perM, MILLION);
  const input = per(usage.inputTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens, price.inputPerM);
  const output = per(usage.outputTokens, price.outputPerM);
  const cacheRead = per(usage.cacheReadTokens, price.cachedInputPerM ?? price.inputPerM);
  return { input, output, cacheWrite: 0n, cacheRead, total: input + output + cacheRead };
}
