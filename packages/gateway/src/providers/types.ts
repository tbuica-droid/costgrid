import type { PriceModifiers, Provider, TokenUsage } from "@costgrid/core";

/**
 * What the gateway needs to know to proxy and meter one provider.
 *
 * Everything provider-specific lives behind this interface: the route it
 * serves, how it authenticates, where usage hides in a response, and how its
 * streaming format reports totals. The proxy handler itself stays
 * provider-agnostic, which is what keeps adding the third one cheap.
 */
export interface ProviderAdapter {
  readonly id: Provider;
  /** The path clients call on the gateway; also the upstream path. */
  readonly path: string;
  readonly defaultBaseUrl: string;
  /** Env var holding this provider's credential. */
  readonly apiKeyEnvVar: string;

  authHeaders(apiKey: string): Record<string, string>;
  /** Request headers worth forwarding upstream, lower-cased. */
  readonly forwardedRequestHeaders: readonly string[];
  /** Response headers worth passing back to the caller, lower-cased. */
  readonly forwardedResponseHeaders: readonly string[];

  modelOf(body: unknown): string;
  maxOutputTokensOf(body: unknown): number;
  isStreaming(body: unknown): boolean;

  /**
   * Adjust the outgoing body so the response will carry usage.
   *
   * Returns the body to send and whether we changed anything. OpenAI omits
   * usage from streamed responses unless asked; Anthropic always includes it.
   */
  prepareBody(body: unknown): { body: unknown; injectedUsageRequest: boolean };

  parseBufferedResponse(payload: unknown): ParsedResponse;
  createStreamCollector(): StreamUsageCollector;
}

export interface ParsedResponse {
  readonly model: string | undefined;
  readonly usage: TokenUsage | undefined;
  readonly modifiers: PriceModifiers;
  readonly stopReason: string | undefined;
}

/**
 * Accumulates usage from a streaming response as it passes through.
 *
 * Implementations must never throw: the caller's bytes are already being
 * forwarded, and a metering failure is not a reason to corrupt a response.
 * Parse problems are counted, not raised.
 */
export interface StreamUsageCollector {
  feed(chunk: string): void;
  end(): void;

  readonly usage: TokenUsage;
  readonly model: string | undefined;
  readonly stopReason: string | undefined;
  readonly modifiers: PriceModifiers;
  readonly parseErrors: number;

  /**
   * True when the stream did not yield trustworthy usage — it was truncated,
   * or the provider never reported totals. The call is then recorded with the
   * cost unestablished rather than as zero, which surfaces as an unpriced
   * call instead of silently under-reporting spend.
   */
  readonly incomplete: boolean;
  /** Why it is incomplete, for the call record. */
  readonly incompleteReason: string | undefined;
}
