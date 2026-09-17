import { createSign } from "node:crypto";
import { NO_MODIFIERS, parseAnthropicModifiers, parseAnthropicUsage } from "@costgrid/core";
import { AnthropicStreamCollector } from "./anthropic-stream.js";
import { cappedTools, toolName } from "./tools.js";
import type { AuthContext, ParsedResponse, ProviderAdapter } from "./types.js";

/**
 * Google Vertex AI, carrying Anthropic models.
 *
 * Simpler than Bedrock in every way that matters: the bodies are Anthropic's,
 * and a stream is ordinary SSE, so the direct adapter's stream collector is
 * reused wholesale rather than reimplemented. The only genuinely new part is
 * authentication — a service-account key signs a JWT, which is exchanged for a
 * short-lived OAuth token.
 *
 * NOT VERIFIED AGAINST A LIVE PROJECT. The JWT is signed with node's crypto
 * and the exchange follows the documented flow, but nothing here has spoken to
 * Google. `costgrid preflight vertex` settles it in one command.
 */

const TOKEN_ENDPOINT = process.env["COSTGRID_GOOGLE_TOKEN_URL"] ?? "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function record(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

export interface ServiceAccount {
  readonly client_email: string;
  readonly private_key: string;
  readonly project_id?: string;
}

/** The credential is the service-account JSON, as downloaded from GCP. */
export function parseServiceAccount(credential: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    throw new Error("Vertex credential must be the service-account JSON");
  }
  const account = record(parsed);
  if (typeof account?.["client_email"] !== "string" || typeof account["private_key"] !== "string") {
    throw new Error("service-account JSON needs client_email and private_key");
  }
  return account as unknown as ServiceAccount;
}

const base64url = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64url");

/**
 * Cached access tokens, keyed by service account.
 *
 * Google's tokens last an hour. Fetching one per request would add a round
 * trip to every call the gateway proxies, which is the opposite of what a
 * latency-sensitive proxy should do. Refreshed a minute early, because a token
 * that expires in flight fails the request it was fetched for.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const REFRESH_MARGIN_MS = 60_000;

export async function accessTokenFor(
  credential: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const account = parseServiceAccount(credential);
  const cached = tokenCache.get(account.client_email);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached.token;

  const issuedAt = Math.floor(now / 1000);
  const claims = {
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(claims),
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(account.private_key)
    .toString("base64url");

  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${signingInput}.${signature}`,
    }).toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    // Google's own message ("invalid_grant: account not found") is far more
    // actionable than "auth failed".
    throw new Error(`google token exchange returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const payload = record(JSON.parse(text));
  const token = payload?.["access_token"];
  if (typeof token !== "string") throw new Error("google token response had no access_token");

  const expiresIn = typeof payload?.["expires_in"] === "number" ? payload["expires_in"] : 3600;
  tokenCache.set(account.client_email, { token, expiresAt: now + expiresIn * 1000 });
  return token;
}

/** Exposed so a test can prove the cache is used rather than assumed. */
export function __clearTokenCache(): void {
  tokenCache.clear();
}

export const vertexAdapter: ProviderAdapter = {
  id: "vertex",
  // What the Anthropic Vertex SDK posts to, so pointing it at CostGrid stays a
  // one-line change. Project and location come from configuration, not the
  // path, because they are deployment facts rather than per-request ones.
  path: "/v1/vertex/messages",
  defaultBaseUrl: "https://us-east5-aiplatform.googleapis.com",
  apiKeyEnvVar: "GOOGLE_SERVICE_ACCOUNT_JSON",

  async authHeaders(credential: string, _context: AuthContext): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await accessTokenFor(credential)}` };
  },

  forwardedRequestHeaders: ["anthropic-beta"],
  forwardedResponseHeaders: ["content-type", "x-request-id", "retry-after"],

  modelOf: (body) => {
    const value = record(body)?.["model"];
    return typeof value === "string" && value !== "" ? value : "unknown";
  },

  upstreamPath(model, streaming): string {
    const project = process.env["GOOGLE_CLOUD_PROJECT"] ?? "";
    const location = process.env["GOOGLE_CLOUD_LOCATION"] ?? "us-east5";
    const verb = streaming ? "streamRawPredict" : "rawPredict";
    return (
      `/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}` +
      `/publishers/anthropic/models/${encodeURIComponent(model)}:${verb}`
    );
  },

  // Vertex takes the model in the path, so routing rewrites the URL and the
  // body is left alone.
  withModel: (body) => body,

  maxOutputTokensOf: (body) => {
    const value = record(body)?.["max_tokens"];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  },

  isStreaming: (body) => record(body)?.["stream"] === true,

  prepareBody(body) {
    const source = record(body);
    if (!source) return { body, injectedUsageRequest: false };
    // Same shape as Bedrock: the model is in the path, and Vertex requires its
    // own `anthropic_version` marker instead.
    const { model: _model, ...rest } = source;
    return { body: { anthropic_version: "vertex-2023-10-16", ...rest }, injectedUsageRequest: false };
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
      model: typeof message["model"] === "string" ? message["model"] : undefined,
      usage: message["usage"] !== undefined ? parseAnthropicUsage(message["usage"]) : undefined,
      modifiers: parseAnthropicModifiers(message["usage"]),
      stopReason: typeof message["stop_reason"] === "string" ? message["stop_reason"] : undefined,
      invokedTools,
    };
  },

  // A Vertex stream is Anthropic's SSE, event for event.
  createStreamCollector: () => new AnthropicStreamCollector(),
};
