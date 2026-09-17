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

  /**
   * Headers that authenticate one upstream request.
   *
   * Async and context-carrying because two channels need more than a static
   * token: Bedrock signs the method, path and body with SigV4, and Vertex
   * exchanges a service-account key for a short-lived OAuth token. A bearer
   * header ignores the context and stays a one-liner.
   */
  authHeaders(credential: string, context: AuthContext): Promise<Record<string, string>>;

  /**
   * The upstream path for one model.
   *
   * Bedrock and Vertex put the model in the URL rather than the body, and
   * stream from a different path than they buffer from. Taking the model here
   * is what lets a route rule rewrite the destination without the proxy
   * handler knowing which channel it is talking to.
   */
  upstreamPath(model: string, streaming: boolean): string;
  /** Request headers worth forwarding upstream, lower-cased. */
  readonly forwardedRequestHeaders: readonly string[];
  /** Response headers worth passing back to the caller, lower-cased. */
  readonly forwardedResponseHeaders: readonly string[];

  /**
   * The model this request asks for.
   *
   * `params` carries the route parameters, because a channel that puts the
   * model in the path has nothing useful in the body.
   */
  modelOf(body: unknown, params?: Record<string, string | undefined>): string;
  /** Return a copy of the body with a different model. Never mutates the input. */
  withModel(body: unknown, model: string): unknown;
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

  /**
   * Tool *names* the request declares the model may call.
   *
   * Names only, never definitions: a tool's description and schema are the
   * customer's content. The name is structural and is all a reachability
   * policy needs.
   */
  declaredTools(body: unknown): readonly string[];
}

/** What an adapter needs in order to authenticate one request. */
export interface AuthContext {
  readonly method: string;
  /** The fully-resolved upstream URL, including host and path. */
  readonly url: URL;
  /** The exact body bytes that will be sent, which SigV4 signs. */
  readonly body: string;
}

export interface ParsedResponse {
  readonly model: string | undefined;
  readonly usage: TokenUsage | undefined;
  readonly modifiers: PriceModifiers;
  readonly stopReason: string | undefined;
  /** Tool names the model asked to run. Arguments are never read. */
  readonly invokedTools: readonly string[];
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
  /** Tool names seen in the stream. Names only; argument deltas are ignored. */
  readonly invokedTools: readonly string[];

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
