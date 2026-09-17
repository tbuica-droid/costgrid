import {
  NO_MODIFIERS,
  parseAnthropicModifiers,
  parseAnthropicUsage,
  type PriceModifiers,
  type TokenUsage,
  ZERO_USAGE,
} from "@costgrid/core";
import { EventStreamDecoder } from "./eventstream.js";
import { signRequest } from "./sigv4.js";
import { cappedTools, MAX_TOOLS_PER_CALL, toolName } from "./tools.js";
import type { AuthContext, ParsedResponse, ProviderAdapter, StreamUsageCollector } from "./types.js";

/**
 * Amazon Bedrock, carrying Anthropic models.
 *
 * The request and response bodies are Anthropic's, so everything about
 * counting tokens is already proven by the direct adapter's tests. What is
 * different, and what this file is for, is the packaging: the model lives in
 * the URL, the credential is an AWS signature over the whole request, and a
 * stream arrives as binary event-stream frames rather than SSE.
 *
 * Two fields Bedrock rejects are stripped, because the client sends what the
 * Anthropic SDK builds: `model` (it is in the path) and `stream` (the path
 * decides). `anthropic_version` is required instead, and defaulted here.
 *
 * NOT VERIFIED AGAINST A LIVE ACCOUNT. The signature is checked against
 * Amazon's published example and the frame decoder against the canonical CRC
 * vector, but nothing here has spoken to Bedrock. `costgrid preflight bedrock`
 * is one command and settles it.
 */

const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

function record(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/** AWS credentials arrive as one env value so a single secret can be rotated. */
export function parseAwsCredential(credential: string): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
} {
  // `AKIA...:secret:region` or `AKIA...:secret:region:sessionToken`
  const parts = credential.split(":");
  if (parts.length < 3) {
    throw new Error(
      "AWS credential must be accessKeyId:secretAccessKey:region[:sessionToken]",
    );
  }
  const [accessKeyId, secretAccessKey, region, sessionToken] = parts;
  return {
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    region: region!,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

export const bedrockAdapter: ProviderAdapter = {
  id: "bedrock",
  // The path clients already use: boto3 and AnthropicBedrock both post here,
  // so pointing either at CostGrid stays a one-line change.
  path: "/model/:modelId/invoke",
  defaultBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  apiKeyEnvVar: "AWS_BEDROCK_CREDENTIAL",

  async authHeaders(credential: string, context: AuthContext): Promise<Record<string, string>> {
    const aws = parseAwsCredential(credential);
    return signRequest({
      method: context.method,
      url: context.url,
      region: aws.region,
      service: "bedrock",
      body: context.body,
      credentials: {
        accessKeyId: aws.accessKeyId,
        secretAccessKey: aws.secretAccessKey,
        sessionToken: aws.sessionToken,
      },
    });
  },

  forwardedRequestHeaders: [],
  forwardedResponseHeaders: ["content-type", "x-amzn-requestid", "retry-after"],

  /**
   * Bedrock names the model in the path, so the route parameter is the truth
   * and the body usually has no `model` at all.
   */
  modelOf(body, params): string {
    const fromPath = params?.["modelId"];
    if (typeof fromPath === "string" && fromPath !== "") return decodeURIComponent(fromPath);
    const inBody = record(body)?.["model"];
    return typeof inBody === "string" && inBody !== "" ? inBody : "unknown";
  },

  upstreamPath(model, streaming): string {
    const id = encodeURIComponent(model);
    return streaming ? `/model/${id}/invoke-with-response-stream` : `/model/${id}/invoke`;
  },

  /**
   * Routing rewrites the URL, not the body — so this only has to not lie.
   *
   * Returning the body unchanged is correct: `upstreamPath` receives the
   * routed model and builds the new destination.
   */
  withModel: (body) => body,

  maxOutputTokensOf: (body) => {
    const value = record(body)?.["max_tokens"];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  },

  /**
   * Streaming is decided by the path the client called, which the proxy has
   * already resolved into the route. The body's `stream` flag is Anthropic's
   * spelling and Bedrock rejects it.
   */
  isStreaming: (body) => record(body)?.["stream"] === true,

  prepareBody(body) {
    const source = record(body);
    if (!source) return { body, injectedUsageRequest: false };

    // `model` and `stream` belong to the Anthropic API; Bedrock puts the first
    // in the path and infers the second from it, and rejects the request if
    // either is present in the body.
    const { model: _model, stream: _stream, ...rest } = source;
    return {
      body: { anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...rest },
      injectedUsageRequest: false,
    };
  },

  declaredTools(body): readonly string[] {
    const tools = record(body)?.["tools"];
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
      // Bedrock echoes no model in the body; the caller knows it from the path.
      model: typeof message["model"] === "string" ? message["model"] : undefined,
      usage: message["usage"] !== undefined ? parseAnthropicUsage(message["usage"]) : undefined,
      modifiers: parseAnthropicModifiers(message["usage"]),
      stopReason: typeof message["stop_reason"] === "string" ? message["stop_reason"] : undefined,
      invokedTools,
    };
  },

  createStreamCollector: () => new BedrockStreamCollector(),
};

/**
 * Collects usage from a Bedrock stream.
 *
 * Each frame's payload is `{"bytes": "<base64 of one Anthropic SSE event>"}`,
 * so once a frame is decoded the event inside is exactly what the direct
 * adapter already understands. The final `message_stop` frame also carries
 * `amazon-bedrock-invocationMetrics`, which is Bedrock's own token count and
 * is preferred over the accumulated one when present — the provider's figure
 * beats ours by definition.
 */
export class BedrockStreamCollector implements StreamUsageCollector {
  readonly #decoder = new EventStreamDecoder();
  #usage: TokenUsage = ZERO_USAGE;
  #sawUsage = false;
  #model: string | undefined;
  #stopReason: string | undefined;
  #modifiers: PriceModifiers = NO_MODIFIERS;
  #parseErrors = 0;
  #tools: string[] = [];

  feed(chunk: string): void {
    // The proxy decodes bytes to a string before handing them over, which is
    // lossy for binary. `latin1` is a byte-preserving round trip.
    this.#push(Buffer.from(chunk, "latin1"));
  }

  /** Preferred where raw bytes are available, as in the preflight check. */
  feedBytes(chunk: Buffer): void {
    this.#push(chunk);
  }

  #push(bytes: Buffer): void {
    let messages;
    try {
      messages = this.#decoder.push(bytes);
    } catch {
      this.#parseErrors += 1;
      return;
    }

    for (const message of messages) {
      try {
        this.#handle(message.payload);
      } catch {
        this.#parseErrors += 1;
      }
    }
  }

  #handle(payload: Buffer): void {
    const wrapper = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;

    const encoded = wrapper["bytes"];
    if (typeof encoded !== "string") return;
    const event = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;

    switch (event["type"]) {
      case "message_start": {
        const message = event["message"] as Record<string, unknown> | undefined;
        if (!message) return;
        if (typeof message["model"] === "string") this.#model = message["model"];
        if (message["usage"] !== undefined) {
          this.#usage = parseAnthropicUsage(message["usage"]);
          this.#modifiers = parseAnthropicModifiers(message["usage"]);
          this.#sawUsage = true;
        }
        return;
      }
      case "content_block_start": {
        const block = event["content_block"] as Record<string, unknown> | undefined;
        if (block?.["type"] !== "tool_use") return;
        const name = toolName(block["name"]);
        if (name !== undefined && !this.#tools.includes(name) && this.#tools.length < MAX_TOOLS_PER_CALL) {
          this.#tools.push(name);
        }
        return;
      }
      case "message_delta": {
        const delta = event["delta"] as Record<string, unknown> | undefined;
        if (typeof delta?.["stop_reason"] === "string") this.#stopReason = delta["stop_reason"];
        const usage = event["usage"] as Record<string, unknown> | undefined;
        if (usage?.["output_tokens"] !== undefined) {
          this.#usage = { ...this.#usage, outputTokens: Number(usage["output_tokens"]) };
          this.#sawUsage = true;
        }
        return;
      }
      default:
        break;
    }

    // Bedrock's own totals, on the terminal frame. The provider's count beats
    // anything accumulated here.
    const metrics = event["amazon-bedrock-invocationMetrics"] as
      | Record<string, unknown>
      | undefined;
    if (metrics) {
      this.#usage = {
        ...this.#usage,
        inputTokens: Number(metrics["inputTokenCount"] ?? this.#usage.inputTokens),
        outputTokens: Number(metrics["outputTokenCount"] ?? this.#usage.outputTokens),
        cacheReadTokens: Number(
          metrics["cacheReadInputTokenCount"] ?? this.#usage.cacheReadTokens,
        ),
        cacheWrite5mTokens: Number(
          metrics["cacheWriteInputTokenCount"] ?? this.#usage.cacheWrite5mTokens,
        ),
      };
      this.#sawUsage = true;
    }
  }

  end(): void {
    /* Frames are self-delimiting; nothing is buffered past the last one. */
  }

  get usage(): TokenUsage {
    return this.#usage;
  }
  get model(): string | undefined {
    return this.#model;
  }
  get stopReason(): string | undefined {
    return this.#stopReason;
  }
  get modifiers(): PriceModifiers {
    return this.#modifiers;
  }
  get invokedTools(): readonly string[] {
    return this.#tools;
  }
  get parseErrors(): number {
    return this.#parseErrors + this.#decoder.errors;
  }

  get incomplete(): boolean {
    return !this.#sawUsage || this.#decoder.errors > 0;
  }

  get incompleteReason(): string | undefined {
    if (this.#decoder.errors > 0) return "bedrock stream framing did not decode";
    if (!this.#sawUsage) return "bedrock stream reported no usage";
    return undefined;
  }
}
