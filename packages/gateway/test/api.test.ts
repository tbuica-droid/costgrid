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
  providerKeys: { anthropic: "sk-ant-test-not-a-real-key" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  logLevel: "silent",
};

const MESSAGE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 2_000 },
};

describe("dashboard API", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let app: FastifyInstance;
  let apiKey: string;

  const auth = () => ({ "x-costgrid-key": apiKey });

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "agent-a").plaintext;

    app = createServer({
      config: CONFIG,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const model = JSON.parse(String(init?.body)).model as string;
        return new Response(JSON.stringify({ ...MESSAGE, model }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    // Seed some real traffic through the real proxy path.
    for (const [model, agent] of [
      ["claude-opus-5", "writer"],
      ["claude-haiku-4-5", "classifier"],
      ["claude-haiku-4-5", "classifier"],
    ] as const) {
      await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { ...auth(), "x-costgrid-agent": agent, "x-costgrid-department": "Eng" },
        payload: { model, max_tokens: 100 },
      });
    }
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  // -------------------------------------------------------------- auth

  it("requires a key on every /api route", async () => {
    for (const url of ["/api/overview", "/api/agents", "/api/policies", "/api/routing"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("scopes every response to the caller's own tenant", async () => {
    repository.createTenant("Other", "t2");
    const otherKey = repository.createApiKey("t2", "b").plaintext;

    const mine = await app.inject({ method: "GET", url: "/api/overview", headers: auth() });
    const theirs = await app.inject({
      method: "GET",
      url: "/api/overview",
      headers: { "x-costgrid-key": otherKey },
    });

    expect(mine.json().calls).toBe(3);
    expect(theirs.json().calls).toBe(0);
  });

  // ---------------------------------------------------------- money shape

  it("serialises money as decimal strings, never floats", async () => {
    const res = await app.inject({ method: "GET", url: "/api/overview", headers: auth() });
    const body = res.json();

    expect(typeof body.totalCostUsd).toBe("string");
    // Each stub call is 1k input, 500 output, 2k cache-read.
    //   Opus:  $0.0050 + $0.01250 + $0.0010 = $0.0185
    //   Haiku: $0.0010 + $0.00250 + $0.0002 = $0.0037, twice = $0.0074
    expect(body.totalCostUsd).toBe("0.025900");

    const agents = await app.inject({ method: "GET", url: "/api/agents", headers: auth() });
    for (const agent of agents.json()) {
      expect(typeof agent.costUsd).toBe("string");
      expect(typeof agent.costPerCallUsd).toBe("string");
    }
  });

  it("prices the catalog per million tokens", async () => {
    const res = await app.inject({ method: "GET", url: "/api/models", headers: auth() });
    const { models } = res.json();
    const opus = models.find((m: { id: string }) => m.id === "claude-opus-5");

    expect(opus.inputPerMTokUsd).toBe("5.00");
    expect(opus.outputPerMTokUsd).toBe("25.00");
    // Three decimals, because OpenAI publishes rates as fine as $0.005/MTok.
    expect(opus.cacheReadPerMTokUsd).toBe("0.500");
    // Fast mode is a real rate, not a footnote — it doubles the bill.
    expect(opus.fastInputPerMTokUsd).toBe("10.00");
    expect(opus.fastOutputPerMTokUsd).toBe("50.00");

    const sonnet = models.find((m: { id: string }) => m.id === "claude-sonnet-5");
    expect(sonnet.fastInputPerMTokUsd).toBeNull();
  });

  it("ships per-provider provenance alongside the prices", async () => {
    const res = await app.inject({ method: "GET", url: "/api/models", headers: auth() });
    const { catalog, models } = res.json();

    expect(catalog.providers.map((p: { provider: string }) => p.provider).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
    for (const entry of catalog.providers) {
      expect(entry.source).toMatch(/^https:\/\//);
      expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // The catalog as a whole is only as fresh as its stalest provider.
    expect(catalog.verifiedAt).toBe(
      catalog.providers.map((p: { verifiedAt: string }) => p.verifiedAt).sort()[0],
    );
    expect(typeof catalog.stale).toBe("boolean");

    // Both providers' models are listed, each tagged with its own provider.
    const providers = new Set(models.map((m: { provider: string }) => m.provider));
    expect([...providers].sort()).toEqual(["anthropic", "openai"]);
  });

  it("exposes the OpenAI long-context tier", async () => {
    const res = await app.inject({ method: "GET", url: "/api/models", headers: auth() });
    const astra = res.json().models.find((m: { id: string }) => m.id === "gpt-6-astra");

    expect(astra.inputPerMTokUsd).toBe("10.00");
    expect(astra.longContextInputPerMTokUsd).toBe("20.00");
    expect(astra.longContextThresholdTokens).toBe(272_000);
  });

  it("reports catalog staleness on the overview so the banner can render", async () => {
    const res = await app.inject({ method: "GET", url: "/api/overview", headers: auth() });
    expect(typeof res.json().catalogStale).toBe("boolean");
    expect(typeof res.json().catalogAgeDays).toBe("number");
  });

  // -------------------------------------------------------------- content

  it("reports per-agent detail computed from real calls", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agents", headers: auth() });
    const byId = Object.fromEntries(res.json().map((a: { agentId: string }) => [a.agentId, a]));

    expect(byId["classifier"].calls).toBe(2);
    expect(byId["classifier"].costUsd).toBe("0.007400"); // 2 x $0.0037
    expect(byId["classifier"].costPerCallUsd).toBe("0.003700");
    // 2000 cached of (1000 uncached + 2000 cached) per call
    expect(byId["writer"].cacheHitRatio).toBeCloseTo(2 / 3, 6);
  });

  it("separates measured share from modelled optimum", async () => {
    const res = await app.inject({ method: "GET", url: "/api/routing", headers: auth() });
    const body = res.json();

    // 2 of 3 calls on Haiku, identical token counts => 2/3 off frontier.
    expect(body.observedShare).toBeCloseTo(2 / 3, 6);
    expect(body.optimalShare).toBeCloseTo(0.8253, 4);
    expect(body.curve).toHaveLength(101);
    expect(body.assumptions.riskExponent).toBe(8);
  });

  it("groups tokens by tier, keeping uncatalogued models visible", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tiers", headers: auth() });
    const tiers = Object.fromEntries(res.json().map((t: { tier: string }) => [t.tier, t]));

    expect(tiers["frontier"].calls).toBe(1);
    expect(tiers["small"].calls).toBe(2);
  });

  it("rejects a bad days parameter instead of guessing", async () => {
    for (const days of ["0", "-5", "abc", "99999"]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/overview?days=${days}`,
        headers: auth(),
      });
      expect(res.statusCode, days).toBe(400);
    }
  });

  it("rejects an unknown breakdown dimension", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/spend/by/agent_id;DROP",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });

  // ------------------------------------------------------------- policies

  it("creates a budget policy from a decimal-string limit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/policies",
      headers: auth(),
      payload: {
        name: "monthly cap",
        action: "block",
        scope: { kind: "tenant" },
        rule: { kind: "budget", window: "month", limitUsd: "125.50" },
      },
    });

    expect(res.statusCode).toBe(201);
    const stored = repository.listPolicies("t1")[0];
    expect(stored?.rule).toMatchObject({ kind: "budget", limit: usd("125.50") });
  });

  it("rejects malformed policy payloads", async () => {
    const bad = [
      { action: "destroy", scope: { kind: "tenant" }, rule: { kind: "budget" } },
      { action: "block", scope: { kind: "nonsense" }, rule: { kind: "budget" } },
      { action: "block", scope: { kind: "agent" }, rule: { kind: "budget" } },
      {
        action: "block",
        scope: { kind: "tenant" },
        rule: { kind: "budget", window: "week", limitUsd: "1" },
      },
      {
        action: "block",
        scope: { kind: "tenant" },
        rule: { kind: "budget", window: "month", limitUsd: 5 },
      },
      { action: "block", scope: { kind: "tenant" }, rule: { kind: "model-allowlist", models: [] } },
      {
        action: "block",
        scope: { kind: "tenant" },
        rule: { kind: "max-output-tokens", limit: -1 },
      },
      { action: "block", scope: { kind: "tenant" }, rule: { kind: "invented" } },
    ];

    for (const payload of bad) {
      const res = await app.inject({ method: "POST", url: "/api/policies", headers: auth(), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(repository.listPolicies("t1")).toHaveLength(0);
  });

  it("toggles a policy, and refuses one belonging to another tenant", async () => {
    repository.createTenant("Other", "t2");
    const foreign = repository.createPolicy("t2", {
      name: "theirs",
      scope: { kind: "tenant" },
      rule: { kind: "max-output-tokens", limit: 10 },
      action: "block",
      enabled: true,
    });
    const mine = repository.createPolicy("t1", {
      name: "mine",
      scope: { kind: "tenant" },
      rule: { kind: "max-output-tokens", limit: 10 },
      action: "block",
      enabled: true,
    });

    const cross = await app.inject({
      method: "PATCH",
      url: `/api/policies/${foreign}`,
      headers: auth(),
      payload: { enabled: false },
    });
    expect(cross.statusCode).toBe(404);
    expect(repository.listPolicies("t2")[0]?.enabled).toBe(true); // untouched

    const own = await app.inject({
      method: "PATCH",
      url: `/api/policies/${mine}`,
      headers: auth(),
      payload: { enabled: false },
    });
    expect(own.statusCode).toBe(200);
    expect(repository.listPolicies("t1").find((p) => p.id === mine)?.enabled).toBe(false);
  });

  // ------------------------------------------------------------- static

  it("serves the dashboard shell and its assets", async () => {
    const page = await app.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.body).toContain("CostGrid");

    for (const [file, type] of [
      ["app.js", /javascript/],
      ["styles.css", /text\/css/],
    ] as const) {
      const res = await app.inject({ method: "GET", url: `/app/${file}` });
      expect(res.statusCode, file).toBe(200);
      expect(res.headers["content-type"]).toMatch(type);
    }
  });

  it("refuses to serve anything outside the web root", async () => {
    for (const path of [
      "/app/..%2F..%2F..%2F.env",
      "/app/../../../etc/passwd",
      "/app/../src/config.ts",
      "/app/config.ts",
    ]) {
      const res = await app.inject({ method: "GET", url: path });
      expect([400, 404], path).toContain(res.statusCode);
      expect(res.body).not.toContain("ANTHROPIC_API_KEY");
    }
  });

  it("keeps the dashboard from shadowing the proxy route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: auth(),
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });
    expect(res.statusCode).toBe(200);
  });
});
