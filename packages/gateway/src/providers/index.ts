import {
  NO_MODIFIERS,
  parseAnthropicModifiers,
  parseAnthropicUsage,
  parseOpenAiUsage,
  type Provider,
} from "@costgrid/core";
import { AnthropicStreamCollector } from "./anthropic-stream.js";
import { bedrockAdapter } from "./bedrock.js";
import { OpenAiStreamCollector } from "./openai-stream.js";
import { vertexAdapter } from "./vertex.js";
import type { ParsedResponse, ProviderAdapter } from "./types.js";
import { cappedTools, toolName } from "./tools.js";
import { sseError } from "./sse.js";

export * from "./types.js";
export { AnthropicStreamCollector } from "./anthropic-stream.js";
export { OpenAiStreamCollector } from "./openai-stream.js";
export { bedrockAdapter, BedrockStreamCollector } from "./bedrock.js";
export { vertexAdapter } from "./vertex.js";
export { sseError } from "./sse.js";

function record(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

function stringField(body: unknown, key: string, fallback: string): string {
  const value = record(body)?.[key];
  return typeof value === "string" && value !== "" ? value : fallback;
}

function numberField(body: unknown, key: string): number {
  const value = record(body)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  path: "/v1/messages",
  defaultBaseUrl: "https://api.anthropic.com",
  apiKeyEnvVar: "ANTHROPIC_API_KEY",

  authHeaders: async (apiKey) => ({ "x-api-key": apiKey }),

  // Beta flags are semantically part of the request; dropping one silently
  // changes behaviour, so they are forwarded verbatim.
  forwardedRequestHeaders: ["anthropic-version", "anthropic-beta"],
  forwardedResponseHeaders: [
    "content-type",
    "request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
    "retry-after",
  ],

  modelOf: (body) => stringField(body, "model", "unknown"),
  upstreamPath(): string {
    return this.path;
  },
  withModel: (body, model) => ({ ...(record(body) ?? {}), model }),
  maxOutputTokensOf: (body) => numberField(body, "max_tokens"),
  isStreaming: (body) => record(body)?.["stream"] === true,

  // Anthropic reports usage on every response, streamed or not.
  prepareBody: (body) => ({ body, injectedUsageRequest: false }),

  declaredTools(body): readonly string[] {
    const request = record(body);
    const tools = request?.["tools"];
    if (!Array.isArray(tools)) return [];
    return cappedTools(tools.map((tool) => toolName(record(tool)?.["name"])));
  },

  parseBufferedResponse(payload): ParsedResponse {
    const message = record(payload);
    if (!message) {
      return {
        model: undefined,
        usage: undefined,
        modifiers: NO_MODIFIERS,
        stopReason: undefined,
        invokedTools: [],
      };
    }

    const content = message["content"];
    const invokedTools = Array.isArray(content)
      ? cappedTools(
          content.map((block) => {
            const b = record(block);
            return b?.["type"] === "tool_use" ? toolName(b["name"]) : undefined;
          }),
        )
      : [];

    return {
      model: typeof message["model"] === "string" ? message["model"] : undefined,
      usage: message["usage"] !== undefined ? parseAnthropicUsage(message["usage"]) : undefined,
      modifiers: parseAnthropicModifiers(message["usage"]),
      stopReason: typeof message["stop_reason"] === "string" ? message["stop_reason"] : undefined,
      invokedTools,
    };
  },

  createStreamCollector: () => new AnthropicStreamCollector(),
  streamError: sseError,
};

export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  path: "/v1/chat/completions",
  defaultBaseUrl: "https://api.openai.com",
  apiKeyEnvVar: "OPENAI_API_KEY",

  authHeaders: async (apiKey) => ({ authorization: `Bearer ${apiKey}` }),

  forwardedRequestHeaders: ["openai-organization", "openai-project", "openai-beta"],
  forwardedResponseHeaders: [
    "content-type",
    "x-request-id",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
    "retry-after",
  ],

  modelOf: (body) => stringField(body, "model", "unknown"),
  upstreamPath(): string {
    return this.path;
  },
  withModel: (body, model) => ({ ...(record(body) ?? {}), model }),
  // Chat Completions renamed max_tokens to max_completion_tokens; accept both,
  // because an output cap that silently reads zero would never fire.
  maxOutputTokensOf: (body) =>
    numberField(body, "max_completion_tokens") || numberField(body, "max_tokens"),
  isStreaming: (body) => record(body)?.["stream"] === true,

  /**
   * Ask for usage on streamed calls.
   *
   * OpenAI omits usage from a stream unless `stream_options.include_usage` is
   * set, so without this every streamed call would meter as zero. We only add
   * it when the caller did not specify `stream_options` at all — if they set
   * it deliberately, that is their decision and we record the resulting
   * unmetered call as unpriced rather than overriding them.
   *
   * The cost of asking is one extra trailing chunk with an empty `choices`
   * array. That is documented OpenAI behaviour and every official SDK handles
   * it, but a hand-rolled parser that assumes `choices[0]` exists could trip
   * over it — hence `COSTGRID_OPENAI_INJECT_USAGE=false` to opt out.
   */
  prepareBody(body) {
    const source = record(body);
    if (!source || source["stream"] !== true) return { body, injectedUsageRequest: false };
    if (source["stream_options"] !== undefined) return { body, injectedUsageRequest: false };

    return {
      body: { ...source, stream_options: { include_usage: true } },
      injectedUsageRequest: true,
    };
  },

  declaredTools(body): readonly string[] {
    const request = record(body);
    const tools = request?.["tools"];
    if (!Array.isArray(tools)) return [];
    return cappedTools(
      tools.map((tool) => {
        const t = record(tool);
        // Function tools nest the name; newer built-in tools name themselves
        // by type alone.
        return toolName(record(t?.["function"])?.["name"] ?? t?.["name"] ?? t?.["type"]);
      }),
    );
  },

  parseBufferedResponse(payload): ParsedResponse {
    const message = record(payload);
    if (!message) {
      return {
        model: undefined,
        usage: undefined,
        modifiers: NO_MODIFIERS,
        stopReason: undefined,
        invokedTools: [],
      };
    }

    const choices = message["choices"];
    const finishReason =
      Array.isArray(choices) && choices.length > 0
        ? (choices[0] as Record<string, unknown> | undefined)?.["finish_reason"]
        : undefined;

    const invokedTools = Array.isArray(choices)
      ? cappedTools(
          choices.flatMap((choice) => {
            const calls = record(record(choice)?.["message"])?.["tool_calls"];
            if (!Array.isArray(calls)) return [];
            return calls.map((c) => toolName(record(record(c)?.["function"])?.["name"]));
          }),
        )
      : [];

    return {
      model: typeof message["model"] === "string" ? message["model"] : undefined,
      usage: message["usage"] != null ? parseOpenAiUsage(message["usage"]) : undefined,
      modifiers: NO_MODIFIERS,
      invokedTools,
      stopReason:
        typeof finishReason === "string"
          ? finishReason
          : typeof message["status"] === "string"
            ? message["status"]
            : undefined,
    };
  },

  createStreamCollector: () => new OpenAiStreamCollector(),
  streamError: sseError,
};

export const ADAPTERS: readonly ProviderAdapter[] = [
  anthropicAdapter,
  openaiAdapter,
  bedrockAdapter,
  vertexAdapter,
];

export function adapterFor(provider: Provider): ProviderAdapter {
  const adapter = ADAPTERS.find((a) => a.id === provider);
  if (!adapter) throw new Error(`no adapter for provider ${provider}`);
  return adapter;
}
