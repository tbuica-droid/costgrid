import { usd } from "@costgrid/core";
import { Analytics, CostGridRepository, ImportsRepository, openDatabase } from "@costgrid/db";
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

/** 1M in, 1M out, so a rate reads straight off as dollars. */
const USAGE = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe("auto-routing", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;
  let app: FastifyInstance;
  let apiKey: string;
  let sentModels: string[];

  /** Echoes back whichever model the request actually asked for. */
  function boot(): void {
    sentModels = [];
    app = createServer({
      config: CONFIG,
      repository,
      analytics,
      imports: new ImportsRepository(db),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        sentModels.push(body.model);
        return new Response(
          JSON.stringify({ model: body.model, stop_reason: "end_turn", usage: USAGE }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
  }

  const send = (model: string, agent = "worker") =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": agent },
      payload: { model, max_tokens: 100 },
    });

  const window = () => ({ from: 0, to: Date.now() + 1000 });

  const addRoute = (
    rule: { toModel: string; from?: string[] },
    action: "monitor" | "warn" | "block" = "warn",
    scope: Parameters<CostGridRepository["createPolicy"]>[1]["scope"] = { kind: "tenant" },
  ) =>
    repository.createPolicy("t1", {
      name: `route to ${rule.toModel}`,
      scope,
      rule: { kind: "route", ...rule },
      action,
      enabled: true,
    });

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    analytics = new Analytics(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    boot();
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  // ------------------------------------------------------------------ basics

  it("rewrites the model and realises the saving", async () => {
    addRoute({ toModel: "claude-haiku-4-5" });

    const res = await send("claude-opus-5");
    expect(res.statusCode).toBe(200);
    expect(sentModels).toEqual(["claude-haiku-4-5"]); // upstream got the cheap one

    // Opus would have been $5 + $25 = $30; Haiku is $1 + $5 = $6.
    const savings = analytics.routingSavings("t1", window());
    expect(savings.routedCalls).toBe(1);
    expect(savings.realisedSaving).toBe(usd("24.00"));
    expect(analytics.summary("t1", window()).totalCost).toBe(usd("6.00"));
  });

  it("tells the caller it rerouted them", async () => {
    addRoute({ toModel: "claude-haiku-4-5" });
    const res = await send("claude-opus-5");

    expect(res.headers["x-costgrid-routed"]).toBe("claude-opus-5->claude-haiku-4-5");
    expect(res.headers["x-costgrid-warnings"]).toMatch(/routed from claude-opus-5/);
  });

  it("records what was asked for alongside what was served", async () => {
    addRoute({ toModel: "claude-haiku-4-5" });
    await send("claude-opus-5");

    const row = db
      .prepare("SELECT requested_model AS requested, model, routed FROM calls")
      .get() as { requested: string; model: string; routed: number };

    // Without requested_model a rerouted call looks identical to one that
    // simply used a cheap model, and the saving cannot be proven.
    expect(row.requested).toBe("claude-opus-5");
    expect(row.model).toBe("claude-haiku-4-5");
    expect(row.routed).toBe(1);
  });

  // ----------------------------------------------------------------- dry run

  it("monitor is a real dry run: nothing is rewritten", async () => {
    addRoute({ toModel: "claude-haiku-4-5" }, "monitor");

    const res = await send("claude-opus-5");
    expect(sentModels).toEqual(["claude-opus-5"]); // untouched
    expect(res.headers["x-costgrid-routed"]).toMatch(/^dry-run:/);
    // A dry run must not claim credit in the caller's warnings header.
    expect(res.headers["x-costgrid-warnings"]).toBeUndefined();

    const savings = analytics.routingSavings("t1", window());
    expect(savings.routedCalls).toBe(0);
    expect(savings.realisedSaving).toBe(0n);
    // …but it does show what it would have saved.
    expect(savings.dryRunCalls).toBe(1);
    expect(savings.potentialSaving).toBe(usd("24.00"));
  });

  it("keeps realised and potential savings apart", async () => {
    // One live rule for Sonnet traffic, one dry run for Opus traffic.
    addRoute({ from: ["claude-sonnet-5"], toModel: "claude-haiku-4-5" }, "warn");
    addRoute({ from: ["claude-opus-5"], toModel: "claude-haiku-4-5" }, "monitor");

    await send("claude-sonnet-5");
    await send("claude-opus-5");

    const savings = analytics.routingSavings("t1", window());
    // Sonnet ($2 + $10 = $12) -> Haiku ($6) realised $6.
    expect(savings.realisedSaving).toBe(usd("6.00"));
    // Opus -> Haiku would have saved $24, but did not.
    expect(savings.potentialSaving).toBe(usd("24.00"));
  });

  // ------------------------------------------------------------------ guards

  it("refuses to route across providers", async () => {
    // An Anthropic request body is not a valid OpenAI one; rewriting `model`
    // across providers would send a malformed request upstream.
    addRoute({ toModel: "gpt-5-nano" });

    await send("claude-opus-5");
    expect(sentModels).toEqual(["claude-opus-5"]);
    expect(analytics.routingSavings("t1", window()).routedCalls).toBe(0);
  });

  it("refuses to route to a model it cannot price", async () => {
    // Otherwise the customer sees their traffic move and their spend go to zero.
    addRoute({ toModel: "claude-not-a-real-model" });

    await send("claude-opus-5");
    expect(sentModels).toEqual(["claude-opus-5"]);
  });

  it("ignores a rule that routes a model to itself", async () => {
    addRoute({ toModel: "claude-opus-5" });
    const res = await send("claude-opus-5");

    expect(sentModels).toEqual(["claude-opus-5"]);
    expect(res.headers["x-costgrid-routed"]).toBeUndefined();
  });

  it("only touches the source models the rule names", async () => {
    addRoute({ from: ["claude-opus-5"], toModel: "claude-haiku-4-5" });

    await send("claude-sonnet-5");
    expect(sentModels).toEqual(["claude-sonnet-5"]);

    await send("claude-opus-5");
    expect(sentModels).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
  });

  it("does not route a blocked call", async () => {
    repository.createPolicy("t1", {
      name: "no opus",
      scope: { kind: "tenant" },
      rule: { kind: "model-denylist", models: ["claude-opus-5"] },
      action: "block",
      enabled: true,
    });
    addRoute({ toModel: "claude-haiku-4-5" });

    const res = await send("claude-opus-5");
    expect(res.statusCode).toBe(403);
    expect(sentModels).toHaveLength(0); // nothing reached the provider at all
  });

  it("applies only the first matching rule, never chaining", async () => {
    addRoute({ toModel: "claude-sonnet-5" });
    addRoute({ toModel: "claude-haiku-4-5" });

    await send("claude-opus-5");
    // Not opus -> sonnet -> haiku.
    expect(sentModels).toEqual(["claude-sonnet-5"]);
  });

  it("respects scope", async () => {
    addRoute({ toModel: "claude-haiku-4-5" }, "warn", { kind: "agent", agentId: "chatty" });

    await send("claude-opus-5", "quiet");
    expect(sentModels).toEqual(["claude-opus-5"]);

    await send("claude-opus-5", "chatty");
    expect(sentModels).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
  });

  it("ignores a disabled rule", async () => {
    const id = addRoute({ toModel: "claude-haiku-4-5" });
    repository.setPolicyEnabled(id, false);

    await send("claude-opus-5");
    expect(sentModels).toEqual(["claude-opus-5"]);
  });

  // ------------------------------------------------------------- honesty

  it("shows a route that costs more as a loss, not a clamped zero", async () => {
    // A savings figure that can only go up is a marketing number.
    addRoute({ from: ["claude-haiku-4-5"], toModel: "claude-opus-5" });

    await send("claude-haiku-4-5");
    const savings = analytics.routingSavings("t1", window());
    expect(savings.realisedSaving).toBe(usd("-24.00"));
  });

  it("breaks the saving down per substitution so it can be audited", async () => {
    addRoute({ from: ["claude-opus-5"], toModel: "claude-haiku-4-5" });
    await send("claude-opus-5");
    await send("claude-opus-5");

    const [row] = analytics.routingBreakdown("t1", window());
    expect(row?.requestedModel).toBe("claude-opus-5");
    expect(row?.servedModel).toBe("claude-haiku-4-5");
    expect(row?.calls).toBe(2);
    expect(row?.saving).toBe(usd("48.00"));
    expect(row?.dryRun).toBe(false);
  });

  it("puts routing in the same enforcement feed as everything else", async () => {
    addRoute({ toModel: "claude-haiku-4-5" });
    await send("claude-opus-5");

    const [event] = analytics.recentViolations("t1");
    expect(event?.reason).toMatch(/routed from claude-opus-5 to claude-haiku-4-5/);
    expect(event?.action).toBe("warn");
  });

  it("routes streaming calls too", async () => {
    addRoute({ toModel: "claude-haiku-4-5" });
    await app.close();

    app = createServer({
      config: CONFIG,
      repository,
      analytics,
      imports: new ImportsRepository(db),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        sentModels.push(body.model);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "message_start",
                  message: { model: body.model, usage: { input_tokens: 1_000_000 } },
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { output_tokens: 1_000_000 },
                })}\n\n`,
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch,
    });

    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey },
      payload: { model: "claude-opus-5", max_tokens: 100, stream: true },
    });

    expect(sentModels).toEqual(["claude-haiku-4-5"]);
    expect(analytics.routingSavings("t1", window()).realisedSaving).toBe(usd("24.00"));
  });

  // --------------------------------------------------------- soft fallback

  describe("soft fallback", () => {
    const addBudget = (
      usdLimit: string,
      fallbackModel: string | undefined,
      action: "monitor" | "warn" | "block" = "block",
    ) =>
      repository.createPolicy("t1", {
        name: "monthly cap",
        scope: { kind: "tenant" },
        rule: {
          kind: "budget",
          window: "month",
          limit: usd(usdLimit),
          ...(fallbackModel ? { fallbackModel } : {}),
        },
        action,
        enabled: true,
      });

    /** Burn $30 of the budget on one Opus call, leaving the tenant over a $10 cap. */
    const burn = async () => {
      await send("claude-opus-5");
      expect(analytics.summary("t1", window()).totalCost).toBe(usd("30.00"));
      sentModels = [];
    };

    it("keeps answering on a cheaper model instead of returning 403", async () => {
      addBudget("10.00", "claude-haiku-4-5");
      await burn();

      const res = await send("claude-opus-5");

      expect(res.statusCode).toBe(200);
      expect(sentModels).toEqual(["claude-haiku-4-5"]);
      expect(res.headers["x-costgrid-fallback"]).toBe("claude-opus-5->claude-haiku-4-5");
      expect(res.headers["x-costgrid-warnings"]).toMatch(/over budget: downgraded/);

      // $30 already spent, plus $6 for the downgraded call.
      expect(analytics.summary("t1", window()).totalCost).toBe(usd("36.00"));
      expect(analytics.routingSavings("t1", window()).realisedSaving).toBe(usd("24.00"));
    });

    it("without a fallback, the same cap still refuses the call", async () => {
      addBudget("10.00", undefined);
      await burn();

      const res = await send("claude-opus-5");

      expect(res.statusCode).toBe(403);
      expect(sentModels).toEqual([]);
    });

    it("leaves traffic alone while the budget still has room", async () => {
      addBudget("1000.00", "claude-haiku-4-5");

      const res = await send("claude-opus-5");
      expect(sentModels).toEqual(["claude-opus-5"]);
      expect(res.headers["x-costgrid-fallback"]).toBeUndefined();
    });

    it("monitor records the downgrade without making it", async () => {
      addBudget("10.00", "claude-haiku-4-5", "monitor");
      await burn();

      const res = await send("claude-opus-5");

      expect(sentModels).toEqual(["claude-opus-5"]);
      expect(res.headers["x-costgrid-fallback"]).toMatch(/^dry-run:/);
      const savings = analytics.routingSavings("t1", window());
      expect(savings.routedCalls).toBe(0);
      expect(savings.dryRunCalls).toBe(1);
      expect(savings.potentialSaving).toBe(usd("24.00"));
    });

    it("blocks once the traffic is already on the fallback model", async () => {
      // Nothing cheaper is left to give, so a hard cap is a hard cap again.
      addBudget("10.00", "claude-haiku-4-5");
      await burn();

      const res = await send("claude-haiku-4-5");
      expect(res.statusCode).toBe(403);
      expect(sentModels).toEqual([]);
    });

    it("a warn-action cap never blocks, even with nowhere to downgrade to", async () => {
      addBudget("10.00", "claude-haiku-4-5", "warn");
      await burn();

      const res = await send("claude-haiku-4-5");
      expect(res.statusCode).toBe(200);
      expect(sentModels).toEqual(["claude-haiku-4-5"]);
    });

    it("survives a policy name a header cannot hold", async () => {
      // Node throws on non-latin-1 header values. A customer naming a policy
      // "Q3 cap — Engineering" must not turn every call into a 500.
      repository.createPolicy("t1", {
        name: "Q3 cap \u2014 Engineering \u2192 Haiku",
        scope: { kind: "tenant" },
        rule: {
          kind: "budget",
          window: "month",
          limit: usd("10.00"),
          fallbackModel: "claude-haiku-4-5",
        },
        action: "warn",
        enabled: true,
      });
      await burn();

      const res = await send("claude-opus-5");
      expect(res.statusCode).toBe(200);
      expect(sentModels).toEqual(["claude-haiku-4-5"]);
      // The name reaches the caller through the route reason, transliterated.
      expect(res.headers["x-costgrid-warnings"]).toContain("Q3 cap ? Engineering ? Haiku");
    });

    it("outranks a standing route rule", async () => {
      addRoute({ toModel: "claude-sonnet-5" });
      addBudget("10.00", "claude-haiku-4-5");

      // The first call is under budget, so the standing rule applies.
      await send("claude-opus-5");
      expect(sentModels).toEqual(["claude-sonnet-5"]);

      // Sonnet cost $12, which blows the $10 cap; now the fallback takes over.
      await send("claude-opus-5");
      expect(sentModels).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
    });
  });
});
