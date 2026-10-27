import { readFileSync } from "node:fs";
import { Analytics, CostGridRepository, ImportsRepository, openDatabase } from "@costgrid/db";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer, REQUEST_ID_HEADER } from "../src/server.js";

const CONFIG: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  backupDir: "",
  backupKeep: 7,
  providerKeys: { anthropic: "sk-ant-test" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  extractTools: true,
  allowAnonymous: true,
  hosted: false,
  desktop: false,
  masterKeySecret: undefined,
  masterKeySource: "env",
  secureCookies: false,
  publicUrl: undefined,
  anchorUrl: undefined,
  anchorKey: undefined,
  anchorIntervalMinutes: 60,
  logLevel: "silent",
  logFile: undefined,
};

const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(config: Partial<GatewayConfig> = {}, db = openDatabase({ path: ":memory:" })): FastifyInstance {
  // What start.ts does for an anonymous self-hosted gateway.
  if (db.open && !db.readonly && db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tenants'").get() !== undefined) {
    new CostGridRepository(db).createTenant("Local", "local");
  }
  app = createServer({
    config: { ...CONFIG, ...config },
    db,
    repository: new CostGridRepository(db),
    analytics: new Analytics(db),
    accounts: undefined,
    imports: new ImportsRepository(db),
    fetchImpl: (async () =>
      new Response(JSON.stringify(MESSAGE), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
  return app;
}

describe("health and readiness", () => {
  it("reports the version the build was released as", async () => {
    const body = (await build().inject({ method: "GET", url: "/health" })).json() as { version: string };
    expect(body.version).toBe(PACKAGE_VERSION);
    expect(body.version).not.toBe("0.1.0");
  });

  it("is ready when the database is open and current", async () => {
    const res = await build().inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true });
  });

  it("is not ready, but still alive, when the schema is behind the build", async () => {
    // A bare database with no migrations applied stands in for one this build
    // has not upgraded yet.
    const behind = new Database(":memory:");
    const server = build({}, behind);
    const ready = await server.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ ready: false });
    expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});

describe("request ids", () => {
  it("puts an id on every answer", async () => {
    const res = await build().inject({ method: "GET", url: "/health" });
    expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a caller's own id when it is a sane token, and replaces anything else", async () => {
    const server = build();
    const kept = await server.inject({ method: "GET", url: "/health", headers: { [REQUEST_ID_HEADER]: "job-42.retry-1" } });
    expect(kept.headers[REQUEST_ID_HEADER]).toBe("job-42.retry-1");
    const replaced = await server.inject({
      method: "GET",
      url: "/health",
      headers: { [REQUEST_ID_HEADER]: "<script>alert(1)</script>" },
    });
    expect(replaced.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("/metrics", () => {
  it("counts requests by route pattern and times what CostGrid adds before forwarding", async () => {
    const server = build();
    await server.inject({ method: "GET", url: "/health" });
    const call = await server.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json" },
      payload: { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
    });
    expect(call.statusCode).toBe(200);

    const res = await server.inject({ method: "GET", url: "/metrics", remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain(`costgrid_build_info{version="${PACKAGE_VERSION}"} 1`);
    expect(res.body).toMatch(/costgrid_http_requests_total\{method="GET",route="\/health",status="2xx"\} 1/);
    expect(res.body).toMatch(/costgrid_preforward_seconds_count\{provider="anthropic"\} 1/);
  });

  it("is hidden from other machines without a token, and always when hosted without one", async () => {
    expect((await build().inject({ method: "GET", url: "/metrics", remoteAddress: "203.0.113.9" })).statusCode).toBe(404);
  });

  it("is served to whoever holds the token, and no one else", async () => {
    const token = "a-metrics-token-that-is-long-enough";
    const server = build({ metricsToken: token });
    const without = await server.inject({ method: "GET", url: "/metrics", remoteAddress: "203.0.113.9" });
    expect(without.statusCode).toBe(404);
    const wrong = await server.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(404);
    const right = await server.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${token}` } });
    expect(right.statusCode).toBe(200);
  });
});
