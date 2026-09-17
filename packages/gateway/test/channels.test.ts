import { usd } from "@costgrid/core";
import { Analytics, CostGridRepository, ImportsRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { bedrockAdapter, BedrockStreamCollector } from "../src/providers/bedrock.js";
import { encodeEventStreamMessage } from "../src/providers/eventstream.js";
import { accessTokenFor, __clearTokenCache, vertexAdapter } from "../src/providers/vertex.js";
import { createServer } from "../src/server.js";

/** 1M in, 1M out — a rate reads straight off as dollars. */
const USAGE = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

const BASE: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: {},
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  extractTools: true,
  allowAnonymous: false,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  logLevel: "silent",
};

describe("Bedrock", () => {
  describe("packaging", () => {
    it("takes the model from the path, where Bedrock puts it", () => {
      expect(bedrockAdapter.modelOf({}, { modelId: "anthropic.claude-opus-4-5-v1:0" })).toBe(
        "anthropic.claude-opus-4-5-v1:0",
      );
      // boto3 percent-encodes the colon; both spellings name one model.
      expect(bedrockAdapter.modelOf({}, { modelId: "anthropic.claude-opus-4-5-v1%3A0" })).toBe(
        "anthropic.claude-opus-4-5-v1:0",
      );
    });

    it("streams from a different path than it buffers from", () => {
      expect(bedrockAdapter.upstreamPath("anthropic.claude-opus-4-5-v1:0", false)).toBe(
        "/model/anthropic.claude-opus-4-5-v1%3A0/invoke",
      );
      expect(bedrockAdapter.upstreamPath("anthropic.claude-opus-4-5-v1:0", true)).toBe(
        "/model/anthropic.claude-opus-4-5-v1%3A0/invoke-with-response-stream",
      );
    });

    it("strips the two fields Bedrock rejects and adds the one it demands", () => {
      const { body } = bedrockAdapter.prepareBody({
        model: "claude-opus-5",
        stream: true,
        max_tokens: 100,
        messages: [],
      });
      // `model` is in the path and `stream` is implied by it; Bedrock 400s on
      // either being present in the body.
      expect(body).toEqual({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 100,
        messages: [],
      });
    });

    it("routes by rewriting the URL, not the body", () => {
      // The model is not in the body, so withModel has nothing to change —
      // and must not pretend otherwise.
      const original = { max_tokens: 10 };
      expect(bedrockAdapter.withModel(original, "anthropic.claude-haiku-4-5-v1:0")).toBe(original);
      expect(bedrockAdapter.upstreamPath("anthropic.claude-haiku-4-5-v1:0", false)).toContain(
        "claude-haiku",
      );
    });
  });

  describe("stream collector", () => {
    const frame = (event: unknown) =>
      encodeEventStreamMessage(
        "chunk",
        Buffer.from(
          JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") }),
        ),
      );

    it("reads usage out of the base64-wrapped Anthropic events", () => {
      const collector = new BedrockStreamCollector();
      collector.feedBytes(
        frame({
          type: "message_start",
          message: { model: "claude-opus-4-5", usage: { input_tokens: 1000, output_tokens: 0 } },
        }),
      );
      collector.feedBytes(
        frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 250 } }),
      );
      collector.end();

      expect(collector.usage.inputTokens).toBe(1000);
      expect(collector.usage.outputTokens).toBe(250);
      expect(collector.stopReason).toBe("end_turn");
      expect(collector.incomplete).toBe(false);
    });

    it("prefers Bedrock's own invocation metrics over the accumulated count", () => {
      // The provider's figure beats ours by definition.
      const collector = new BedrockStreamCollector();
      collector.feedBytes(
        frame({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } }),
      );
      collector.feedBytes(
        frame({
          type: "message_stop",
          "amazon-bedrock-invocationMetrics": {
            inputTokenCount: 4242,
            outputTokenCount: 99,
            cacheReadInputTokenCount: 7,
          },
        }),
      );

      expect(collector.usage.inputTokens).toBe(4242);
      expect(collector.usage.outputTokens).toBe(99);
      expect(collector.usage.cacheReadTokens).toBe(7);
    });

    it("collects tool names", () => {
      const collector = new BedrockStreamCollector();
      collector.feedBytes(
        frame({ type: "content_block_start", content_block: { type: "tool_use", name: "query_db" } }),
      );
      expect(collector.invokedTools).toEqual(["query_db"]);
    });

    it("reports a stream that never gave usage as incomplete, not as free", () => {
      const collector = new BedrockStreamCollector();
      collector.feedBytes(frame({ type: "content_block_delta", delta: { text: "hi" } }));
      collector.end();

      expect(collector.incomplete).toBe(true);
      expect(collector.incompleteReason).toMatch(/no usage/);
    });

    it("survives bytes that are not frames at all", () => {
      const collector = new BedrockStreamCollector();
      collector.feedBytes(Buffer.from("this is not an event stream"));
      collector.end();
      // Loud, not silent: an undecodable stream must not meter as zero cost.
      expect(collector.incomplete).toBe(true);
    });
  });

  describe("through the gateway", () => {
    let db: ReturnType<typeof openDatabase>;
    let repository: CostGridRepository;
    let app: FastifyInstance;
    let apiKey: string;
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;

    beforeEach(() => {
      db = openDatabase({ path: ":memory:" });
      repository = new CostGridRepository(db);
      repository.createTenant("Acme", "t1");
      apiKey = repository.createApiKey("t1", "svc").plaintext;
      seen = undefined;

      app = createServer({
        config: {
          ...BASE,
          providerKeys: { bedrock: "AKIDEXAMPLE:secret:us-east-1" },
          providerBaseUrls: { bedrock: "https://bedrock-runtime.us-east-1.amazonaws.com" },
        },
        repository,
        analytics: new Analytics(db),
        imports: new ImportsRepository(db),
        fetchImpl: (async (url: unknown, init?: RequestInit) => {
          seen = {
            url: String(url),
            headers: init?.headers as Record<string, string>,
            body: String(init?.body),
          };
          return new Response(
            JSON.stringify({ stop_reason: "end_turn", usage: USAGE, content: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch,
      });
    });

    afterEach(async () => {
      await app?.close();
      db.close();
    });

    it("meters a Bedrock call and signs it", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/model/anthropic.claude-opus-4-5-v1%3A0/invoke",
        headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "worker" },
        payload: { max_tokens: 100, messages: [] },
      });

      expect(res.statusCode).toBe(200);
      expect(seen?.url).toContain("/model/anthropic.claude-opus-4-5-v1%3A0/invoke");
      expect(seen?.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);

      // Priced against the same catalog entry as the direct API, because it is
      // the same model.
      expect(new Analytics(db).summary("t1", { from: 0, to: Date.now() + 1000 }).totalCost).toBe(
        usd("30.00"),
      );
      const row = db.prepare("SELECT provider, model FROM calls").get() as Record<string, string>;
      expect(row["provider"]).toBe("bedrock");
      expect(row["model"]).toBe("anthropic.claude-opus-4-5-v1:0");
    });

    it("signs the body it actually sends", async () => {
      await app.inject({
        method: "POST",
        url: "/model/anthropic.claude-opus-4-5-v1%3A0/invoke",
        headers: { "x-costgrid-key": apiKey },
        payload: { model: "ignored", max_tokens: 7, messages: [] },
      });

      // The body was rewritten before signing; a signature over the original
      // would be rejected by AWS.
      expect(JSON.parse(seen!.body)).toEqual({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 7,
        messages: [],
      });
      expect(seen!.headers["x-amz-content-sha256"]).toBeDefined();
    });
  });
});

describe("Vertex", () => {
  beforeEach(() => __clearTokenCache());

  it("builds the rawPredict path for a project and location", () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "acme-prod";
    process.env["GOOGLE_CLOUD_LOCATION"] = "europe-west1";
    try {
      expect(vertexAdapter.upstreamPath("claude-opus-4-5@20260101", false)).toBe(
        "/v1/projects/acme-prod/locations/europe-west1/publishers/anthropic/models/claude-opus-4-5%4020260101:rawPredict",
      );
      expect(vertexAdapter.upstreamPath("claude-opus-4-5@20260101", true)).toContain(
        ":streamRawPredict",
      );
    } finally {
      delete process.env["GOOGLE_CLOUD_PROJECT"];
      delete process.env["GOOGLE_CLOUD_LOCATION"];
    }
  });

  it("swaps the model field for Vertex's version marker", () => {
    const { body } = vertexAdapter.prepareBody({ model: "claude-opus-4-5", max_tokens: 5 });
    expect(body).toEqual({ anthropic_version: "vertex-2023-10-16", max_tokens: 5 });
  });

  it("parses an Anthropic-shaped response, because that is what Vertex returns", () => {
    const parsed = vertexAdapter.parseBufferedResponse({
      model: "claude-opus-4-5",
      usage: USAGE,
      stop_reason: "end_turn",
      content: [{ type: "tool_use", name: "search_kb" }],
    });
    expect(parsed.usage?.inputTokens).toBe(1_000_000);
    expect(parsed.invokedTools).toEqual(["search_kb"]);
  });

  describe("token exchange", () => {
    // A throwaway key, generated for this test and used nowhere else.
    const KEY = {
      client_email: "svc@acme.iam.gserviceaccount.com",
      private_key: "",
    };

    beforeEach(async () => {
      const { generateKeyPairSync } = await import("node:crypto");
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      KEY.private_key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    });

    it("signs a JWT and exchanges it for a token", async () => {
      let assertion: string | undefined;
      const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
        assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? undefined;
        return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), {
          status: 200,
        });
      }) as unknown as typeof fetch;

      const token = await accessTokenFor(JSON.stringify(KEY), fakeFetch);
      expect(token).toBe("ya29.test");

      const [header, claims] = assertion!.split(".");
      expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
        alg: "RS256",
        typ: "JWT",
      });
      expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({
        iss: KEY.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
      });
    });

    it("caches the token rather than paying a round trip per call", async () => {
      let calls = 0;
      const fakeFetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch;

      await accessTokenFor(JSON.stringify(KEY), fakeFetch);
      await accessTokenFor(JSON.stringify(KEY), fakeFetch);
      // A token fetch on every proxied call would add a round trip to the one
      // path that must stay fast.
      expect(calls).toBe(1);
    });

    it("refreshes before expiry rather than at it", async () => {
      let calls = 0;
      const fakeFetch = (async () => {
        calls += 1;
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch;

      const now = Date.now();
      await accessTokenFor(JSON.stringify(KEY), fakeFetch, now);
      // 30 seconds before expiry: a token that dies in flight fails the
      // request it was fetched for.
      await accessTokenFor(JSON.stringify(KEY), fakeFetch, now + 3600_000 - 30_000);
      expect(calls).toBe(2);
    });

    it("surfaces Google's own error message", async () => {
      const fakeFetch = (async () =>
        new Response('{"error":"invalid_grant","error_description":"account not found"}', {
          status: 400,
        })) as unknown as typeof fetch;

      await expect(accessTokenFor(JSON.stringify(KEY), fakeFetch)).rejects.toThrow(/account not found/);
    });

    it("rejects a credential that is not service-account JSON", async () => {
      await expect(accessTokenFor("not json")).rejects.toThrow(/service-account JSON/);
      await expect(accessTokenFor('{"client_email":"a"}')).rejects.toThrow(/private_key/);
    });
  });
});
