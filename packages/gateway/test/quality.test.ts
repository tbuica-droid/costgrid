import { AgentsRepository, Analytics, CostGridRepository, ImportsRepository, openDatabase, QualityRepository } from "@costgrid/db";
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

const SECRET_ANSWER = "the customer's refund is approved";

function sse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const event = (data: unknown) => `event: x\ndata: ${JSON.stringify(data)}\n\n`;

describe("quality foundations through the proxy", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let app: FastifyInstance;
  let apiKey: string;
  let answer: { text: string; stop: string; stream?: boolean };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    new AgentsRepository(db).create("t1", { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    answer = { text: "{}", stop: "end_turn" };
    app = createServer({
      config: CONFIG,
      db,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean };
        if (body.stream) {
          return sse([
            event({ type: "message_start", message: { model: body.model, usage: { input_tokens: 10, output_tokens: 1 } } }),
            event({ type: "content_block_delta", delta: { type: "text_delta", text: answer.text } }),
            event({ type: "message_delta", delta: { stop_reason: answer.stop }, usage: { output_tokens: 20 } }),
            event({ type: "message_stop" }),
          ]);
        }
        return new Response(
          JSON.stringify({
            model: body.model,
            content: [{ type: "text", text: answer.text }],
            stop_reason: answer.stop,
            usage: { input_tokens: 10, output_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const send = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot" },
      payload: { model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...extra },
    });
  const checks = () => (db.prepare("SELECT answer_check AS c FROM calls ORDER BY started_at, rowid").all() as { c: string | null }[]).map((r) => r.c);

  it("checks each answer against the agent's spec and keeps only the result", async () => {
    new QualityRepository(db).set("t1", "support-bot", { format: "json", requiredFields: ["decision"] }, null);
    answer = { text: JSON.stringify({ decision: SECRET_ANSWER }), stop: "end_turn" };
    await send();
    answer = { text: JSON.stringify({ note: SECRET_ANSWER }), stop: "end_turn" };
    await send();
    answer = { text: SECRET_ANSWER, stop: "end_turn" };
    await send();
    answer = { text: "{", stop: "max_tokens" };
    await send();
    answer = { text: "", stop: "tool_use" };
    await send();
    expect(checks()).toEqual(["pass", "missing-field", "not-json", "cut-off", null]);

    // The answer text is nowhere in the database.
    const everything = JSON.stringify(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).flatMap((t) =>
        db.prepare(`SELECT * FROM "${t.name}"`).all(),
      ),
    );
    expect(everything).not.toContain("refund is approved");
  });

  it("judges a stream on how it ended, never on a format it did not hold", async () => {
    new QualityRepository(db).set("t1", "support-bot", { format: "json" }, null);
    answer = { text: "not json at all", stop: "end_turn" };
    await send({ stream: true });
    answer = { text: "{", stop: "max_tokens" };
    await send({ stream: true });
    expect(checks()).toEqual([null, "cut-off"]);
  });

  it("logs why a call was routed or sent differently, dry runs included", async () => {
    repository.createPolicy("t1", {
      name: "cheaper", scope: { kind: "tenant" }, rule: { kind: "route", toModel: "claude-haiku-4-5" }, action: "warn", enabled: true,
    });
    repository.createPolicy("t1", {
      name: "cache", scope: { kind: "tenant" }, rule: { kind: "add-cache" }, action: "monitor", enabled: true,
    });
    await send({ system: "You are support." });
    const rows = new QualityRepository(db).recentDecisions("t1");
    expect(rows.map((r) => r.kind).sort()).toEqual(["adjust", "route"]);
    expect(rows.find((r) => r.kind === "route")).toMatchObject({
      requestedModel: "claude-sonnet-4-6",
      chosenModel: "claude-haiku-4-5",
      applied: true,
      rejected: [{ model: "claude-sonnet-4-6" }],
    });
    expect(rows.find((r) => r.kind === "adjust")).toMatchObject({ applied: false, reason: 'dry run: cache:system by "cache"' });
  });

  it("takes a quality score and a signal on outcome reports, and checks both", async () => {
    const report = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/v1/costgrid/outcome", headers: { "x-costgrid-key": apiKey }, payload });
    expect((await report({ run_id: "r1", success: true, quality: 0.85, signal: "edited" })).statusCode).toBe(202);
    expect((await report({ run_id: "r2", success: true, quality: 1.5 })).statusCode).toBe(400);
    expect((await report({ run_id: "r3", success: true, signal: "loved-it" })).statusCode).toBe(400);
    expect((await report({ run_id: "r4", success: false })).statusCode).toBe(202);
    expect(db.prepare("SELECT run_id AS r, quality_milli AS q, signal AS s FROM outcomes ORDER BY run_id").all()).toEqual([
      { r: "r1", q: 850, s: "edited" },
      { r: "r4", q: null, s: null },
    ]);
  });
});
