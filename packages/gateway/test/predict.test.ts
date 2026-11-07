import { Analytics, CostGridRepository, ImportsRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { type Embedder, ModelLabeller } from "../src/task-labeller.js";

const CONFIG: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: { anthropic: "sk-ant-test" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  logLevel: "silent",
};

/** A stand-in for the sentence model: everything is nearest to "summarise". */
const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map((t) => (/Summarise this text/.test(t) || !/^[A-Z][a-z]+ /.test(t) ? [1, 0] : [0, 1])),
};

describe("task labels and predictions", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: FastifyInstance;
  let apiKey: string;

  function boot(labeller?: ModelLabeller) {
    db = openDatabase({ path: ":memory:" });
    const repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    app = createServer({
      config: CONFIG,
      db,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      ...(labeller ? { labeller } : {}),
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        return Response.json({
          model: body.model,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1_000, output_tokens: 100 },
        });
      }) as unknown as typeof fetch,
    });
  }

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const send = (content: string) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot" },
      payload: { model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content }] },
    });
  const labels = () => db.prepare("SELECT task_kind AS kind, task_size AS size, labelled_by AS by FROM calls ORDER BY rowid").all();

  it("labels each call from signals before forwarding, and keeps only the label", async () => {
    boot();
    await send("Please summarise the attached complaint from Mrs Example");
    await send("What time do you open?");
    expect(labels()).toEqual([
      { kind: "summarise", size: "s", by: "signals" },
      { kind: "answer", size: "s", by: "signals" },
    ]);
    const all = JSON.stringify(db.prepare("SELECT * FROM calls").all());
    expect(all).not.toContain("Mrs Example");
  });

  it("lets the local model refine a label after the answer", async () => {
    boot(new ModelLabeller(fakeEmbedder));
    await send("lorem ipsum dolor sit amet");
    await new Promise((r) => setTimeout(r, 20));
    expect(labels()).toEqual([{ kind: "summarise", size: "s", by: "model" }]);
  });

  it("ranks the models an agent may use, with evidence and how sure it is", async () => {
    boot();
    for (let i = 0; i < 5; i += 1) await send("What time do you open?");
    const res = await app.inject({
      method: "POST",
      url: "/v1/costgrid/predict",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot" },
      payload: { sample: { format: "anthropic", request: { messages: [{ role: "user", content: "When do you close?" }] } } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ agent: "support-bot", kind: "answer", current: "claude-sonnet-4-6", calls: 5, labelledCalls: 5 });
    const current = body.models.find((m: { current: boolean }) => m.current);
    expect(current).toMatchObject({ model: "claude-sonnet-4-6", costBasis: "measured", evidence: { calls: 5 } });
    // Only Claude models: the agent opted in to nothing else.
    expect(body.models.every((m: { model: string }) => m.model.startsWith("claude-"))).toBe(true);
    // Every untried model says its starting point is a guess.
    expect(body.models.find((m: { current: boolean }) => !m.current).prior).toContain("not a benchmark");

    const bad = await app.inject({
      method: "POST",
      url: "/v1/costgrid/predict",
      headers: { "x-costgrid-key": apiKey },
      payload: { kind: "poetry" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
