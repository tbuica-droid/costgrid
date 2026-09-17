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
  extractTools: false,
  allowAnonymous: false,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  logLevel: "silent",
};

/** 1M in, 1M out: Opus is $5 + $25 = $30 at list. */
const USAGE = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe("negotiated rates", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;
  let app: FastifyInstance;
  let apiKey: string;

  const window = () => ({ from: 0, to: Date.now() + 1000 });

  const send = (model = "claude-opus-5") =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "worker" },
      payload: { model, max_tokens: 100 },
    });

  const discount = (provider: string, percent: number) =>
    repository.setRateOverride("t1", {
      provider,
      numerator: BigInt(Math.round((100 - percent) * 100)),
      denominator: 10_000n,
      source: "manual",
    });

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    analytics = new Analytics(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    app = createServer({
      config: CONFIG,
      repository,
      analytics,
      imports: new ImportsRepository(db),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        return new Response(
          JSON.stringify({ model: body.model, stop_reason: "end_turn", usage: USAGE }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it("prices at list when no rate is set", async () => {
    await send();
    expect(analytics.summary("t1", window()).totalCost).toBe(usd("30.00"));
  });

  it("reports what the customer pays, and keeps list alongside it", async () => {
    discount("anthropic", 18);
    await send();

    // The whole point: the headline figure reconciles with their invoice.
    expect(analytics.summary("t1", window()).totalCost).toBe(usd("24.60"));

    const row = db.prepare("SELECT cost_total, cost_list FROM calls").get() as {
      cost_total: number;
      cost_list: number;
    };
    // And the catalog price survives, so the discount is provable.
    expect(row.cost_list).toBe(Number(usd("30.00")));
    expect(row.cost_total).toBe(Number(usd("24.60")));
  });

  it("keeps the cost breakdown adding up to its own total", async () => {
    discount("anthropic", 17.5);
    await send();

    const row = db
      .prepare(
        "SELECT cost_input, cost_output, cost_cache_write, cost_cache_read, cost_total FROM calls",
      )
      .get() as Record<string, number>;
    expect(
      row["cost_input"]! + row["cost_output"]! + row["cost_cache_write"]! + row["cost_cache_read"]!,
    ).toBe(row["cost_total"]);
  });

  it("applies the rate to budgets, not just to reports", async () => {
    // A $25 cap against $30 list would bite immediately; at 18% off the call
    // costs $24.60 and must not.
    discount("anthropic", 18);
    repository.createPolicy("t1", {
      name: "cap",
      scope: { kind: "tenant" },
      rule: { kind: "budget", window: "month", limit: usd("25.00") },
      action: "block",
      enabled: true,
    });

    expect((await send()).statusCode).toBe(200);
    // $24.60 spent, still under $25.
    expect((await send()).statusCode).toBe(200);
    expect(analytics.summary("t1", window()).totalCost).toBe(usd("49.20"));
  });

  it("is per provider", async () => {
    discount("anthropic", 50);
    await send();
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "worker" },
      payload: { model: "gpt-5", max_tokens: 100 },
    });

    const rows = db
      .prepare("SELECT provider, cost_total, cost_list FROM calls ORDER BY provider")
      .all() as { provider: string; cost_total: number; cost_list: number }[];
    const anthropic = rows.find((r) => r.provider === "anthropic")!;
    const openai = rows.find((r) => r.provider === "openai")!;

    expect(anthropic.cost_total).toBe(anthropic.cost_list / 2);
    // OpenAI has no rate and must be untouched.
    expect(openai.cost_total).toBe(openai.cost_list);
  });

  it("quotes the routing saving in the same currency as the bill", async () => {
    discount("anthropic", 50);
    repository.createPolicy("t1", {
      name: "route",
      scope: { kind: "tenant" },
      rule: { kind: "route", toModel: "claude-haiku-4-5" },
      action: "warn",
      enabled: true,
    });

    await send("claude-opus-5");
    // Opus $30 -> Haiku $6 saves $24 at list, $12 at half price. A saving
    // quoted at list against a discounted bill would not reconcile.
    expect(analytics.routingSavings("t1", window()).realisedSaving).toBe(usd("12.00"));
  });

  it("puts the rate on the statement, where finance will look", async () => {
    discount("anthropic", 18);
    await send();

    const res = await app.inject({
      method: "GET",
      url: "/api/statement",
      headers: { "x-costgrid-key": apiKey },
    });
    expect(res.json().rates).toEqual([
      { provider: "anthropic", discountPercent: 18, source: "manual" },
    ]);
  });

  it("stops discounting as soon as the rate is cleared", async () => {
    discount("anthropic", 50);
    await send();
    repository.clearRateOverride("t1", "anthropic");
    await send();

    const rows = db.prepare("SELECT cost_total FROM calls ORDER BY started_at").all() as {
      cost_total: number;
    }[];
    // History keeps the price it was recorded at; new calls are at list.
    expect(rows[0]!.cost_total).toBe(Number(usd("15.00")));
    expect(rows[1]!.cost_total).toBe(Number(usd("30.00")));
  });
});
