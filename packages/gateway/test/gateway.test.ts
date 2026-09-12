import { toUsdString, usd } from "@costgrid/core";
import { Analytics, CostGridRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const CONFIG: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: { anthropic: "sk-ant-test-not-a-real-key" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  logLevel: "silent",
};

/** A fake upstream. No test in this file may reach the real provider. */
function stubUpstream(handler: (init: RequestInit) => Response): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) =>
    handler(init ?? {})) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_test" },
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
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const MESSAGE_RESPONSE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

describe("gateway", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;
  let app: FastifyInstance;
  let apiKey: string;
  let upstreamCalls: RequestInit[];

  function boot(
    upstream: (init: RequestInit) => Response,
    config: Partial<GatewayConfig> = {},
  ): void {
    upstreamCalls = [];
    app = createServer({
      config: { ...CONFIG, ...config },
      repository,
      analytics,
      fetchImpl: stubUpstream((init) => {
        upstreamCalls.push(init);
        return upstream(init);
      }),
    });
  }

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    analytics = new Analytics(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "billing-agent").plaintext;
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  // ------------------------------------------------------------------ auth

  it("rejects a request with no key", async () => {
    boot(() => jsonResponse(MESSAGE_RESPONSE));
    const res = await app.inject({ method: "POST", url: "/v1/messages", payload: {} });

    expect(res.statusCode).toBe(401);
    expect(upstreamCalls).toHaveLength(0); // never reached the provider
  });

  it("rejects an unknown key", async () => {
    boot(() => jsonResponse(MESSAGE_RESPONSE));
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": "cg_live_totally-made-up" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a revoked key", async () => {
    const created = repository.createApiKey("t1", "temp");
    repository.revokeApiKey(created.id);
    boot(() => jsonResponse(MESSAGE_RESPONSE));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": created.plaintext },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("attributes anonymous calls to the local tenant only when configured", async () => {
    repository.createTenant("Local", "local");
    boot(() => jsonResponse(MESSAGE_RESPONSE), { allowAnonymous: true });

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-agent": "my-script" },
      payload: { model: "claude-opus-5", max_tokens: 100 },
    });

    expect(res.statusCode).toBe(200);
    const byAgent = analytics.spendByAgent("local", { from: 0, to: Date.now() + 1000 });
    expect(byAgent[0]?.key).toBe("my-script");
  });

  // --------------------------------------------------------------- metering

  it("meters a buffered call and prices it exactly", async () => {
    boot(() => jsonResponse(MESSAGE_RESPONSE));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "reporter" },
      payload: { model: "claude-opus-5", max_tokens: 1024 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(MESSAGE_RESPONSE); // response passed through untouched

    // 1000 input @ $5/MTok = $0.005; 500 output @ $25/MTok = $0.0125
    const spend = repository.spendFor("t1", { kind: "tenant" });
    expect(spend.month).toBe(usd("0.0175"));
  });

  it("passes the caller's beta headers and version upstream", async () => {
    boot(() => jsonResponse(MESSAGE_RESPONSE));
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-costgrid-key": apiKey,
        "anthropic-beta": "fast-mode-2026-02-01",
        "anthropic-version": "2023-06-01",
      },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    const sent = upstreamCalls[0]?.headers as Record<string, string>;
    expect(sent["anthropic-beta"]).toBe("fast-mode-2026-02-01");
    expect(sent["anthropic-version"]).toBe("2023-06-01");
    // The gateway substitutes its own provider credential.
    expect(sent["x-api-key"]).toBe(CONFIG.providerKeys.anthropic);
  });

  it("bills the model that actually ran, not the one requested", async () => {
    boot(() => jsonResponse({ ...MESSAGE_RESPONSE, model: "claude-haiku-4-5" }));

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    const byModel = analytics.spendByModel("t1", { from: 0, to: Date.now() + 1000 });
    expect(byModel[0]?.key).toBe("claude-haiku-4-5");
    // 1000 @ $1/MTok + 500 @ $5/MTok = $0.0035, not the Opus price.
    expect(byModel[0]?.cost).toBe(usd("0.0035"));
  });

  it("records an uncatalogued model as unpriced rather than free", async () => {
    boot(() => jsonResponse({ ...MESSAGE_RESPONSE, model: "claude-opus-99" }));

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-99", max_tokens: 10 },
    });

    const summary = analytics.summary("t1", { from: 0, to: Date.now() + 1000 });
    expect(summary.unpricedCalls).toBe(1);
    expect(summary.inputTokens).toBe(1_000); // usage still captured
  });

  it("records an upstream error without inflating spend", async () => {
    boot(() =>
      jsonResponse({ type: "error", error: { type: "overloaded_error" } }, 529),
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(529);
    const summary = analytics.summary("t1", { from: 0, to: Date.now() + 1000 });
    expect(summary.erroredCalls).toBe(1);
    expect(summary.totalCost).toBe(0n); // errors do not count toward a budget
  });

  it("bills fast mode at the premium rate the response reports", async () => {
    boot(() =>
      jsonResponse({
        ...MESSAGE_RESPONSE,
        usage: { ...MESSAGE_RESPONSE.usage, speed: "fast" },
      }),
    );

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10, speed: "fast" },
    });

    // Standard would be $0.0175; fast mode doubles both rates.
    expect(repository.spendFor("t1", { kind: "tenant" }).month).toBe(usd("0.035"));
  });

  it("adds the data-residency premium when the response says US inference", async () => {
    boot(() =>
      jsonResponse({
        ...MESSAGE_RESPONSE,
        usage: { ...MESSAGE_RESPONSE.usage, inference_geo: "us" },
      }),
    );

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    // $0.0175 x 1.1
    expect(repository.spendFor("t1", { kind: "tenant" }).month).toBe(usd("0.01925"));
  });

  // -------------------------------------------------------------- streaming

  it("streams bytes through verbatim while metering a copy", async () => {
    const chunks = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { model: "claude-opus-5", usage: { input_tokens: 2_000, output_tokens: 1 } },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 750 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    boot(() => sseResponse(chunks));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 4096, stream: true },
    });

    // The client receives exactly what the provider sent.
    expect(res.body).toBe(chunks.join(""));

    // 2000 input @ $5/MTok = $0.010; 750 output @ $25/MTok = $0.01875
    const spend = repository.spendFor("t1", { kind: "tenant" });
    expect(toUsdString(spend.month, 5)).toBe("0.02875");
  });

  it("marks a truncated stream as errored so partial usage is not trusted", async () => {
    boot(() =>
      sseResponse([
        `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } })}\n\n`,
      ]),
    );

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10, stream: true },
    });

    const summary = analytics.summary("t1", { from: 0, to: Date.now() + 1000 });
    expect(summary.erroredCalls).toBe(1);
  });

  // ------------------------------------------------------------ enforcement

  it("blocks a call once the budget is exhausted, before reaching the provider", async () => {
    repository.createPolicy("t1", {
      name: "monthly cap",
      scope: { kind: "tenant" },
      rule: { kind: "budget", window: "month", limit: usd("0.01") },
      action: "block",
      enabled: true,
    });
    boot(() => jsonResponse(MESSAGE_RESPONSE));

    // First call costs $0.0175 and is allowed — spend was zero when it started.
    const first = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });
    expect(first.statusCode).toBe(200);

    // Second call sees $0.0175 against a $0.01 cap.
    const second = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    expect(second.statusCode).toBe(403);
    expect(second.json().error.type).toBe("costgrid_policy_blocked");
    expect(upstreamCalls).toHaveLength(1); // the blocked call never went upstream

    const summary = analytics.summary("t1", { from: 0, to: Date.now() + 1000 });
    expect(summary.blockedCalls).toBe(1);
    expect(analytics.recentViolations("t1")).toHaveLength(1);
  });

  it("blocks a model that is off the allowlist", async () => {
    repository.createPolicy("t1", {
      name: "cheap models only",
      scope: { kind: "tenant" },
      rule: { kind: "model-allowlist", models: ["claude-haiku-4-5"] },
      action: "block",
      enabled: true,
    });
    boot(() => jsonResponse(MESSAGE_RESPONSE));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("lets a warn policy through but annotates the response", async () => {
    repository.createPolicy("t1", {
      name: "output cap advisory",
      scope: { kind: "tenant" },
      rule: { kind: "max-output-tokens", limit: 100 },
      action: "warn",
      enabled: true,
    });
    boot(() => jsonResponse(MESSAGE_RESPONSE));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 8_000 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-costgrid-warnings"]).toMatch(/exceeds the cap of 100/);
    expect(analytics.recentViolations("t1")[0]?.action).toBe("warn");
  });

  it("keeps one agent's budget from blocking another agent", async () => {
    repository.createPolicy("t1", {
      name: "chatty agent cap",
      scope: { kind: "agent", agentId: "chatty" },
      rule: { kind: "budget", window: "month", limit: usd("0.001") },
      action: "block",
      enabled: true,
    });
    boot(() => jsonResponse(MESSAGE_RESPONSE));

    const send = (agent: string) =>
      app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": agent },
        payload: { model: "claude-opus-5", max_tokens: 10 },
      });

    await send("chatty"); // spends $0.0175, blowing its own $0.001 cap
    expect((await send("chatty")).statusCode).toBe(403);
    // A different agent is unaffected, even though tenant spend is well past the cap.
    expect((await send("quiet")).statusCode).toBe(200);
  });

  it("ignores a disabled policy", async () => {
    const id = repository.createPolicy("t1", {
      name: "off",
      scope: { kind: "tenant" },
      rule: { kind: "model-denylist", models: ["claude-opus-5"] },
      action: "block",
      enabled: true,
    });
    repository.setPolicyEnabled(id, false);
    boot(() => jsonResponse(MESSAGE_RESPONSE));

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });
    expect(res.statusCode).toBe(200);
  });

  // ---------------------------------------------------------------- reporting

  it("reports a tenant summary over its own data only", async () => {
    repository.createTenant("Other", "t2");
    const otherKey = repository.createApiKey("t2", "other-agent").plaintext;
    boot(() => jsonResponse(MESSAGE_RESPONSE));

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": otherKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/costgrid/summary",
      headers: { "x-costgrid-key": apiKey },
    });

    const body = res.json();
    expect(body.calls).toBe(1); // tenant isolation
    expect(body.totalCostUsd).toBe("0.017500");
  });

  it("computes substitution share from observed traffic", async () => {
    boot((init) => {
      const model = JSON.parse(String(init.body)).model as string;
      return jsonResponse({ ...MESSAGE_RESPONSE, model });
    });

    // Three calls: two on the open/small tier, one frontier. Equal token counts.
    for (const model of ["claude-haiku-4-5", "claude-haiku-4-5", "claude-opus-5"]) {
      await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-costgrid-key": apiKey },
        payload: { model, max_tokens: 10 },
      });
    }

    const share = analytics.substitutionShare("t1", { from: 0, to: Date.now() + 1000 });
    expect(share).toBeCloseTo(2 / 3, 6);
  });

  it("serves health without a key", async () => {
    boot(() => jsonResponse(MESSAGE_RESPONSE));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});
