import { CostGridRepository, ImportsRepository, Analytics, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { anthropicAdapter, openaiAdapter } from "../src/providers/index.js";

const CONFIG: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: { anthropic: "sk-ant-test", openai: "sk-openai-test" },
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

const USAGE = { input_tokens: 1_000, output_tokens: 500 };

describe("tool extraction", () => {
  describe("parsers", () => {
    it("reads tool names from an Anthropic response and nothing else", () => {
      const parsed = anthropicAdapter.parseBufferedResponse({
        model: "claude-opus-5",
        usage: USAGE,
        content: [
          { type: "text", text: "Refunding the customer now" },
          {
            type: "tool_use",
            id: "tu_1",
            name: "refund_customer",
            // Arguments are content. Nothing may read them.
            input: { customer_id: "cus_884412", amount_usd: 420, reason: "duplicate charge" },
          },
        ],
      });

      expect(parsed.invokedTools).toEqual(["refund_customer"]);
      expect(JSON.stringify(parsed)).not.toContain("cus_884412");
      expect(JSON.stringify(parsed)).not.toContain("duplicate charge");
    });

    it("reads declared tool names without their schemas", () => {
      const tools = anthropicAdapter.declaredTools({
        model: "claude-opus-5",
        tools: [
          {
            name: "query_db",
            description: "Run SQL against the production warehouse",
            input_schema: { type: "object", properties: { sql: { type: "string" } } },
          },
        ],
      });
      expect(tools).toEqual(["query_db"]);
    });

    it("reads OpenAI tool calls and declarations", () => {
      expect(
        openaiAdapter.parseBufferedResponse({
          model: "gpt-5",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "send_email", arguments: '{"to":"a@b.c"}' } },
                ],
              },
            },
          ],
        }).invokedTools,
      ).toEqual(["send_email"]);

      expect(
        openaiAdapter.declaredTools({
          tools: [{ type: "function", function: { name: "run_tests", description: "..." } }],
        }),
      ).toEqual(["run_tests"]);
    });

    it("ignores a name that is not safe to store", () => {
      // Bounded, because a hostile response must not push unbounded text into
      // the database through this path.
      const parsed = anthropicAdapter.parseBufferedResponse({
        content: [
          { type: "tool_use", name: "x".repeat(500) },
          { type: "tool_use", name: "" },
          { type: "tool_use", name: 42 },
          { type: "tool_use", name: "  fine  " },
        ],
      });
      expect(parsed.invokedTools).toEqual(["fine"]);
    });

    it("caps how many tools one call can contribute", () => {
      const content = Array.from({ length: 200 }, (_, i) => ({
        type: "tool_use",
        name: `tool_${i}`,
      }));
      expect(anthropicAdapter.parseBufferedResponse({ content }).invokedTools.length).toBe(64);
    });

    it("collects tool names from a stream without reading argument deltas", () => {
      const collector = anthropicAdapter.createStreamCollector();
      collector.feed(
        'data: {"type":"message_start","message":{"model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      );
      collector.feed(
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"query_db","input":{}}}\n\n',
      );
      collector.feed(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"sql\\":\\"DROP TABLE customers\\"}"}}\n\n',
      );
      collector.feed('data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n');
      collector.end();

      expect(collector.invokedTools).toEqual(["query_db"]);
      expect(JSON.stringify(collector.invokedTools)).not.toContain("DROP TABLE");
    });
  });

  describe("through the gateway", () => {
    let db: ReturnType<typeof openDatabase>;
    let repository: CostGridRepository;
    let analytics: Analytics;
    let app: FastifyInstance;
    let apiKey: string;

    const boot = (config: GatewayConfig = CONFIG) => {
      app = createServer({
        config,
        repository,
        analytics,
        imports: new ImportsRepository(db),
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              model: "claude-opus-5",
              stop_reason: "tool_use",
              usage: USAGE,
              content: [{ type: "tool_use", name: "refund_customer", input: { amount: 9000 } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch,
      });
    };

    const send = () =>
      app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "chat-bot" },
        payload: {
          model: "claude-opus-5",
          max_tokens: 100,
          tools: [{ name: "refund_customer" }, { name: "search_kb" }],
        },
      });

    beforeEach(() => {
      db = openDatabase({ path: ":memory:" });
      repository = new CostGridRepository(db);
      analytics = new Analytics(db);
      repository.createTenant("Acme", "t1");
      apiKey = repository.createApiKey("t1", "svc").plaintext;
    });

    afterEach(async () => {
      await app?.close();
      db.close();
    });

    it("records what was invoked and what was merely available", async () => {
      boot();
      expect((await send()).statusCode).toBe(200);

      const topo = analytics.topology("t1", { from: 0, to: Date.now() + 1000 });
      expect(topo.edges).toContainEqual(
        expect.objectContaining({ kind: "uses", from: "chat-bot", to: "refund_customer" }),
      );
      // Declared but never called: still reachable, still policy-relevant.
      expect(topo.edges).toContainEqual(
        expect.objectContaining({ kind: "grants", from: "chat-bot", to: "search_kb" }),
      );
    });

    it("stores no argument anywhere", async () => {
      boot();
      await send();

      // The blunt version of the promise: grep the whole database.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      for (const { name } of tables) {
        const rows = db.prepare(`SELECT * FROM "${name}"`).all();
        expect(JSON.stringify(rows)).not.toContain("9000");
      }
    });

    it("records nothing when extraction is switched off", async () => {
      boot({ ...CONFIG, extractTools: false });
      expect((await send()).statusCode).toBe(200);

      const topo = analytics.topology("t1", { from: 0, to: Date.now() + 1000 });
      expect(topo.edges.filter((e) => e.kind === "uses" || e.kind === "grants")).toEqual([]);
    });
  });
});
