import { ZERO_USAGE } from "@costgrid/core";
import {
  AgentsRepository,
  Analytics,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
  QualityRepository,
  RoutingRepository,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

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

describe("choosing per request, and cheap first", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let app: FastifyInstance;
  let apiKey: string;
  let sent: string[];
  /** What each model answers. */
  let answers: Record<string, string>;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    new AgentsRepository(db).create("t1", { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    sent = [];
    answers = {};
    app = createServer({
      config: CONFIG,
      db,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        sent.push(body.model);
        return Response.json({
          model: body.model,
          content: [{ type: "text", text: answers[body.model] ?? '{"category":"billing"}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        });
      }) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const send = (content: string, stream = false) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot" },
      payload: { model: "claude-sonnet-4-6", max_tokens: 100, stream, messages: [{ role: "user", content }] },
    });

  it("sends each kind of task to the model the agent's own evidence chose, with the prediction logged", async () => {
    // Sonnet is what the agent mostly uses; 40 Haiku summaries all passed, at a tenth of the cost.
    for (let i = 0; i < 100; i += 1) {
      repository.recordCall({
        id: `s${i}`, tenantId: "t1", agentId: "support-bot", department: "default", provider: "anthropic",
        model: i < 60 ? "claude-sonnet-4-6" : "claude-haiku-4-5", startedAt: Date.now() - 10_000 + i, durationMs: 1,
        streamed: false, usage: ZERO_USAGE,
        cost: { input: i < 60 ? 1_000n : 100n, output: 0n, cacheWrite: 0n, cacheRead: 0n, total: i < 60 ? 1_000n : 100n },
        priced: true, outcome: "ok", answerCheck: "pass", taskKind: "summarise", taskSize: "s",
      });
    }
    const routing = new RoutingRepository(db);
    routing.setSettings("t1", "support-bot", { perRequest: true });
    expect(routing.buildAll()).toBe(1);

    const summary = await send("Please summarise this report");
    expect(summary.headers["x-costgrid-routed"]).toBe("claude-sonnet-4-6->claude-haiku-4-5");
    await send("What time do you open?");
    expect(sent).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);
    const [d] = new QualityRepository(db).recentDecisions("t1").filter((x) => x.policyId === "per-request");
    expect(d).toMatchObject({ kind: "route", chosenModel: "claude-haiku-4-5", predictedQualityMilli: expect.any(Number), confidenceMilli: expect.any(Number) });
    expect(d!.reason).toContain("per-request routing for summarise");
  });

  it("tries the cheap model first and steps up only when its answer clearly fails", async () => {
    new QualityRepository(db).set("t1", "support-bot", { format: "json", requiredFields: ["category"] }, null);
    new RoutingRepository(db).setSettings("t1", "support-bot", { stepUpModel: "claude-haiku-4-5" });

    // The cheap answer passes: one call, on the cheap model.
    let res = await send("Classify this ticket");
    expect(sent).toEqual(["claude-haiku-4-5"]);
    expect(res.headers["x-costgrid-stepped-up"]).toBeUndefined();

    // The cheap answer is not JSON: the request goes to the model it asked for, and the caller gets that answer.
    answers["claude-haiku-4-5"] = "Sorry, here is some prose.";
    sent = [];
    res = await send("Classify this ticket");
    expect(sent).toEqual(["claude-haiku-4-5", "claude-sonnet-4-6"]);
    expect(res.headers["x-costgrid-stepped-up"]).toBe("claude-haiku-4-5->claude-sonnet-4-6");
    expect(res.json().content[0].text).toBe('{"category":"billing"}');
    const rows = db.prepare("SELECT model, answer_check AS c, routed FROM calls ORDER BY rowid DESC LIMIT 2").all();
    expect(rows).toEqual([
      { model: "claude-sonnet-4-6", c: "pass", routed: 0 },
      { model: "claude-haiku-4-5", c: "not-json", routed: 1 },
    ]);

    // A stream is never tried cheap first.
    sent = [];
    await send("Classify this ticket", true);
    expect(sent).toEqual(["claude-sonnet-4-6"]);
  });
});
