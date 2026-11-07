import { usd } from "@costgrid/core";
import {
  AgentsRepository,
  Analytics,
  CostGridRepository,
  EndpointsRepository,
  ImportsRepository,
  openDatabase,
  QualityRepository,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const CONFIG: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: { anthropic: "sk-ant-test", openai: "sk-openai-test" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  logLevel: "silent",
};

const OPEN = "open:local/llama-3.3-70b";

function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("routing across providers and to open models", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let endpoints: EndpointsRepository;
  let app: FastifyInstance;
  let apiKey: string;
  let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    new AgentsRepository(db).create("t1", { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    endpoints = new EndpointsRepository(db);
    // A model running on this computer: no key.
    endpoints.put("t1", { id: "local", name: "Local Llama", baseUrl: "http://127.0.0.1:11434/v1" });
    endpoints.putModel("t1", {
      endpointId: "local",
      model: "llama-3.3-70b",
      price: { inputPerM: usd("0.60"), outputPerM: usd("0.60") },
      priceSource: "https://example.com/pricing",
      pricedOn: "2026-11-07",
    });
    sent = [];
    app = createServer({
      config: CONFIG,
      db,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
        const openAiShape = String(url).endsWith("/chat/completions");
        if (openAiShape && body["stream"] === true) {
          return sse([
            `data: ${JSON.stringify({ id: "c1", model: body["model"], choices: [{ delta: { role: "assistant", content: "Hel" } }] })}\n\n`,
            `data: ${JSON.stringify({ id: "c1", model: body["model"], choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] })}\n\n`,
            `data: ${JSON.stringify({ id: "c1", model: body["model"], choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } })}\n\n`,
            "data: [DONE]\n\n",
          ]);
        }
        if (openAiShape) {
          return Response.json({
            id: "c1",
            model: body["model"],
            choices: [{ message: { role: "assistant", content: "Hello from Llama" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
          });
        }
        return Response.json({
          id: "m1",
          model: body["model"],
          content: [{ type: "text", text: "Hello from Claude" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const route = (toModel: string, from?: string[]) =>
    repository.createPolicy("t1", {
      name: "cheaper",
      scope: { kind: "agent", agentId: "support-bot" },
      rule: { kind: "route", toModel, ...(from ? { from } : {}) },
      action: "warn",
      enabled: true,
    });
  const claudeCall = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot", "anthropic-beta": "x" },
      payload: { model: "claude-sonnet-4-6", max_tokens: 100, system: "Be kind.", messages: [{ role: "user", content: "hi" }], ...extra },
    });
  const lastCall = () =>
    db.prepare("SELECT model, requested_model AS requested, cost_total AS cost, priced FROM calls ORDER BY rowid DESC LIMIT 1").get();

  it("serves a Claude request from an opted-in open model, and answers in Claude's format", async () => {
    endpoints.setDestinations("t1", "support-bot", ["open:local"]);
    route(OPEN);
    const res = await claudeCall();
    expect(res.statusCode).toBe(200);
    expect(sent[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(sent[0]!.body).toMatchObject({
      model: "llama-3.3-70b",
      max_tokens: 100,
      messages: [{ role: "system", content: "Be kind." }, { role: "user", content: "hi" }],
    });
    // No key for a local server, and the caller's Anthropic headers stay behind.
    expect(sent[0]!.headers["authorization"]).toBeUndefined();
    expect(sent[0]!.headers["anthropic-beta"]).toBeUndefined();
    expect(res.json()).toMatchObject({ type: "message", model: OPEN, content: [{ type: "text", text: "Hello from Llama" }], stop_reason: "end_turn" });
    // Priced by the owner's figures: $0.60 + $0.60 for a million tokens each way.
    expect(lastCall()).toEqual({ model: OPEN, requested: "claude-sonnet-4-6", cost: 1_200_000_000, priced: 1 });
  });

  it("translates a streamed answer event by event", async () => {
    endpoints.setDestinations("t1", "support-bot", ["open:local"]);
    route(OPEN);
    const res = await claudeCall({ stream: true });
    expect(sent[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    const types = res.body
      .split("\n")
      .filter((l) => l.startsWith("event: "))
      .map((l) => l.slice(7));
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(lastCall()).toMatchObject({ model: OPEN, cost: 600_000_000, priced: 1 });
  });

  it("serves an OpenAI request from Claude when the agent opted in", async () => {
    endpoints.setDestinations("t1", "support-bot", ["anthropic"]);
    route("claude-haiku-4-5", ["gpt-5"]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot" },
      payload: { model: "gpt-5", messages: [{ role: "system", content: "Be kind." }, { role: "user", content: "hi" }] },
    });
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.headers["x-api-key"]).toBe("sk-ant-test");
    expect(sent[0]!.body).toMatchObject({ model: "claude-haiku-4-5", system: "Be kind.", max_tokens: 4096 });
    expect(res.json()).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "Hello from Claude" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });

  it("never routes an agent that did not opt in", async () => {
    route(OPEN);
    await claudeCall();
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(lastCall()).toMatchObject({ model: "claude-sonnet-4-6" });
  });

  it("keeps a request it cannot translate on its own model, and says why", async () => {
    endpoints.setDestinations("t1", "support-bot", ["open:local"]);
    route(OPEN);
    const res = await claudeCall({ thinking: { type: "enabled", budget_tokens: 2000 } });
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(res.headers["x-costgrid-not-routed"]).toContain("thinking");
    expect(res.headers["x-costgrid-routed"]).toBeUndefined();
    const [d] = new QualityRepository(db).recentDecisions("t1");
    expect(d).toMatchObject({ kind: "not-routed", requestedModel: "claude-sonnet-4-6", chosenModel: "claude-sonnet-4-6" });
    expect(d!.reason).toContain("thinking");
  });

  it("serves a direct call to an open model, and refuses one to an endpoint that does not exist", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot" },
      payload: { model: OPEN, messages: [{ role: "user", content: "hi" }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(sent[0]!.body["model"]).toBe("llama-3.3-70b");
    expect(lastCall()).toMatchObject({ model: OPEN, priced: 1 });
    const missing = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot" },
      payload: { model: "open:nowhere/x", messages: [] },
    });
    expect(missing.statusCode).toBe(400);
  });

  it("does not route to an open model with no price, so nothing meters as free", async () => {
    endpoints.putModel("t1", { endpointId: "local", model: "unpriced" });
    endpoints.setDestinations("t1", "support-bot", ["open:local"]);
    route("open:local/unpriced");
    await claudeCall();
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  });
});
