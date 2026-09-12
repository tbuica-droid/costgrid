import { usd } from "@costgrid/core";
import { Analytics, CostGridRepository, ImportsRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const BOTH_PROVIDERS: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: { anthropic: "sk-ant-test", openai: "sk-openai-test" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  logLevel: "silent",
};

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-5",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 1_000,
    completion_tokens: 200,
    total_tokens: 1_200,
    prompt_tokens_details: { cached_tokens: 0 },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_1" },
  });
}

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("openai provider", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;
  let app: FastifyInstance;
  let apiKey: string;
  let sent: { url: string; init: RequestInit }[];

  function boot(
    upstream: (init: RequestInit) => Response,
    config: Partial<GatewayConfig> = {},
  ): void {
    sent = [];
    app = createServer({
      config: { ...BOTH_PROVIDERS, ...config },
      repository,
      analytics,
      imports: new ImportsRepository(db),
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        sent.push({ url: String(url), init: init ?? {} });
        return upstream(init ?? {});
      }) as unknown as typeof fetch,
    });
  }

  const auth = () => ({ "x-costgrid-key": apiKey });
  const window = () => ({ from: 0, to: Date.now() + 1000 });

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    analytics = new Analytics(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "agent").plaintext;
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  // ------------------------------------------------------------------ routing

  it("serves a route per configured provider", async () => {
    boot(() => jsonResponse(COMPLETION));
    const health = (await app.inject({ method: "GET", url: "/health" })).json();

    expect(health.providers.map((p: { id: string }) => p.id).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  it("404s a provider with no credential rather than failing upstream", async () => {
    boot(() => jsonResponse(COMPLETION), { providerKeys: { anthropic: "sk-ant-test" } });

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-5" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("uses Bearer auth and the OpenAI base URL", async () => {
    boot(() => jsonResponse(COMPLETION));
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-5", max_completion_tokens: 100 },
    });

    expect(sent[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-openai-test");
    // Anthropic's header must not leak onto an OpenAI request.
    expect(headers["x-api-key"]).toBeUndefined();
  });

  // ----------------------------------------------------------------- metering

  it("meters a buffered completion at OpenAI rates", async () => {
    boot(() => jsonResponse(COMPLETION));
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...auth(), "x-costgrid-agent": "summariser" },
      payload: { model: "gpt-5", max_completion_tokens: 100 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(COMPLETION); // passed through untouched

    // 1000 input @ $1.25/MTok = $0.00125; 200 output @ $10/MTok = $0.002
    expect(repository.spendFor("t1", { kind: "tenant" }).month).toBe(usd("0.00325"));
  });

  it("does not double-count cached tokens", async () => {
    boot(() =>
      jsonResponse({
        ...COMPLETION,
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 900 },
        },
      }),
    );

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-5" },
    });

    // 100 uncached @ $1.25 = $0.000125; 900 cached @ $0.125 = $0.0001125.
    // Billing all 1000 at the input rate would give $0.00125 — 5x too much.
    expect(repository.spendFor("t1", { kind: "tenant" }).month).toBe(usd("0.0002375"));
  });

  it("keeps both providers' spend in one tenant view", async () => {
    boot((init) => {
      const body = JSON.parse(String(init.body));
      return body.model.startsWith("gpt")
        ? jsonResponse(COMPLETION)
        : jsonResponse({
            model: "claude-opus-5",
            stop_reason: "end_turn",
            usage: { input_tokens: 1_000, output_tokens: 500 },
          });
    });

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-5" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth(),
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    const byModel = analytics.spendByModel("t1", window());
    expect(byModel.map((r) => r.key).sort()).toEqual(["claude-opus-5", "gpt-5"]);
    // $0.00325 (gpt-5) + $0.0175 (opus) — priced with each provider's own rates.
    expect(analytics.summary("t1", window()).totalCost).toBe(usd("0.02075"));
  });

  it("enforces a budget across providers", async () => {
    repository.createPolicy("t1", {
      name: "tiny cap",
      scope: { kind: "tenant" },
      rule: { kind: "budget", window: "month", limit: usd("0.001") },
      action: "block",
      enabled: true,
    });
    boot(() => jsonResponse(COMPLETION));

    // First OpenAI call spends $0.00325, blowing the $0.001 cap.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: auth(),
          payload: { model: "gpt-5" },
        })
      ).statusCode,
    ).toBe(200);

    // The Anthropic route is now blocked by spend incurred on OpenAI.
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth(),
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });
    expect(blocked.statusCode).toBe(403);
  });

  // ---------------------------------------------------------------- streaming

  it("asks for usage on a stream the caller did not configure", async () => {
    boot(() =>
      sseResponse([
        `data: ${JSON.stringify({ id: "1", model: "gpt-5", choices: [{ delta: { content: "hi" } }] })}\n\n`,
        `data: ${JSON.stringify({ id: "1", model: "gpt-5", choices: [], usage: { prompt_tokens: 400, completion_tokens: 100 } })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-5", stream: true },
    });

    // Without this injection OpenAI reports no usage at all and the call
    // would meter as free.
    expect(JSON.parse(String(sent[0]?.init.body)).stream_options).toEqual({
      include_usage: true,
    });
    // 400 @ $1.25 = $0.0005; 100 @ $10 = $0.001
    expect(repository.spendFor("t1", { kind: "tenant" }).month).toBe(usd("0.0015"));
  });

  it("respects stream_options the caller set deliberately", async () => {
    boot(() => sseResponse(["data: [DONE]\n\n"]));
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-5", stream: true, stream_options: { include_usage: false } },
    });

    expect(JSON.parse(String(sent[0]?.init.body)).stream_options).toEqual({
      include_usage: false,
    });
  });

  it("records a usage-less stream as unpriced, not as free", async () => {
    boot(
      () =>
        sseResponse([
          `data: ${JSON.stringify({ id: "1", model: "gpt-5", choices: [{ delta: { content: "hi" } }] })}\n\n`,
          "data: [DONE]\n\n",
        ]),
      { injectUsageRequest: false },
    );

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-5", stream: true },
    });

    const summary = analytics.summary("t1", window());
    // The crucial property: a stream we could not meter is visible as
    // unpriced rather than silently pulling reported spend toward zero.
    expect(summary.unpricedCalls).toBe(1);
    expect(summary.totalCost).toBe(0n);
  });

  it("does not inject stream_options into a non-streaming request", async () => {
    boot(() => jsonResponse(COMPLETION));
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-5" },
    });
    expect(JSON.parse(String(sent[0]?.init.body)).stream_options).toBeUndefined();
  });

  it("reads finish_reason and the served model from a stream", async () => {
    boot(() =>
      sseResponse([
        `data: ${JSON.stringify({ id: "1", model: "gpt-5-2025-08-07", choices: [{ finish_reason: "length" }] })}\n\n`,
        `data: ${JSON.stringify({ id: "1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );

    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(),
      payload: { model: "gpt-5", stream: true },
    });

    const row = db
      .prepare("SELECT model, stop_reason AS stopReason, provider FROM calls")
      .get() as { model: string; stopReason: string; provider: string };

    expect(row.model).toBe("gpt-5-2025-08-07"); // dated snapshot, priced as gpt-5
    expect(row.stopReason).toBe("length");
    expect(row.provider).toBe("openai");
  });
});
