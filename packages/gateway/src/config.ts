import type { Provider } from "@costgrid/core";

/**
 * Gateway configuration, resolved from the environment at startup.
 *
 * Everything is validated here and nowhere else, so a misconfigured deploy
 * fails at boot with a clear message rather than on the first request.
 */
export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
  readonly databasePath: string;
  /**
   * Upstream credentials, one per provider that is enabled.
   *
   * Held by the gateway, never by the calling service — that indirection is
   * the point: a leaked client key can be revoked in CostGrid without rotating
   * the provider key. A provider absent from this map serves no route at all.
   */
  readonly providerKeys: Partial<Record<Provider, string>>;
  readonly providerBaseUrls: Partial<Record<Provider, string>>;
  /** Upstream request timeout. Long, because a max-effort call legitimately takes minutes. */
  readonly upstreamTimeoutMs: number;
  /**
   * Let adapters modify an outgoing request so the response carries usage.
   *
   * Only OpenAI needs this today (`stream_options.include_usage`), and only
   * when the caller did not set `stream_options` themselves. Turning it off
   * means streamed OpenAI calls record as unpriced — correct, but blind.
   */
  readonly injectUsageRequest: boolean;
  /**
   * When true, a request presenting no valid CostGrid key is attributed to the
   * single local tenant instead of being rejected. For solo/self-hosted use;
   * must stay false in any multi-tenant deployment.
   */
  readonly allowAnonymous: boolean;
  readonly logLevel: string;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export function loadConfig(): GatewayConfig {
  const providerKeys: Partial<Record<Provider, string>> = {};
  const providerBaseUrls: Partial<Record<Provider, string>> = {};

  const anthropicKey = optional("ANTHROPIC_API_KEY");
  if (anthropicKey !== undefined) providerKeys.anthropic = anthropicKey;
  const anthropicBase = optional("ANTHROPIC_BASE_URL");
  if (anthropicBase !== undefined) providerBaseUrls.anthropic = anthropicBase;

  const openaiKey = optional("OPENAI_API_KEY");
  if (openaiKey !== undefined) providerKeys.openai = openaiKey;
  const openaiBase = optional("OPENAI_BASE_URL");
  if (openaiBase !== undefined) providerBaseUrls.openai = openaiBase;

  // A gateway with no upstream credential can meter nothing. Failing at boot
  // beats accepting traffic and 404ing every call.
  if (Object.keys(providerKeys).length === 0) {
    throw new Error(
      "No provider credentials configured. Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY.",
    );
  }

  return {
    port: integer("COSTGRID_PORT", 8787),
    host: process.env["COSTGRID_HOST"]?.trim() || "127.0.0.1",
    databasePath: process.env["COSTGRID_DB"]?.trim() || "./costgrid.db",
    providerKeys,
    providerBaseUrls,
    upstreamTimeoutMs: integer("COSTGRID_UPSTREAM_TIMEOUT_MS", 15 * 60 * 1000),
    injectUsageRequest: boolean("COSTGRID_OPENAI_INJECT_USAGE", true),
    allowAnonymous: boolean("COSTGRID_ALLOW_ANONYMOUS", false),
    logLevel: process.env["COSTGRID_LOG_LEVEL"]?.trim() || "info",
  };
}
