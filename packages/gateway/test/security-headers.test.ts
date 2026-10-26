import { deriveMasterKey } from "@costgrid/core";
import {
  AccountsRepository,
  Analytics,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GatewayConfig, loadConfig } from "../src/config.js";
import { CONTENT_SECURITY_POLICY } from "../src/dashboard.js";
import { STRICT_TRANSPORT_SECURITY } from "../src/security-headers.js";
import { createServer } from "../src/server.js";

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";

const BASE: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: {},
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  extractTools: true,
  allowAnonymous: false,
  hosted: true,
  desktop: false,
  masterKeySecret: MASTER_SECRET,
  masterKeySource: "env",
  secureCookies: true,
  publicUrl: undefined,
  anchorUrl: undefined,
  anchorKey: undefined,
  anchorIntervalMinutes: 60,
  logLevel: "silent",
  logFile: undefined,
};

const SELF_HOSTED: GatewayConfig = {
  ...BASE,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  allowAnonymous: true,
  providerKeys: { anthropic: "sk-ant-test" },
};

describe("security headers and https", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: FastifyInstance | undefined;

  const build = (config: GatewayConfig): FastifyInstance => {
    app = createServer({
      config,
      db,
      repository: new CostGridRepository(db),
      analytics: new Analytics(db),
      accounts: config.hosted ? new AccountsRepository(db, deriveMasterKey(MASTER_SECRET)) : undefined,
      imports: new ImportsRepository(db),
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    return app;
  };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    db.close();
  });

  it("puts the browser headers on the console page and on JSON responses", async () => {
    const server = build(BASE);
    for (const url of ["/console", "/health", "/console/me"]) {
      const res = await server.inject({ method: "GET", url });
      expect(res.headers["content-security-policy"], url).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers["x-content-type-options"], url).toBe("nosniff");
      expect(res.headers["x-frame-options"], url).toBe("DENY");
      expect(res.headers["referrer-policy"], url).toBe("no-referrer");
      expect(res.headers["permissions-policy"], url).toMatch(/camera=\(\)/);
      expect(res.headers["cross-origin-opener-policy"], url).toBe("same-origin");
      expect(res.headers["x-powered-by"], url).toBeUndefined();
    }
    // The console's policy keeps it working: its own scripts, styles and fonts.
    expect(CONTENT_SECURITY_POLICY).toMatch(/script-src 'self'/);
    expect(CONTENT_SECURITY_POLICY).toMatch(/frame-ancestors 'none'/);
  });

  it("sends HSTS from a hosted deployment only", async () => {
    const hosted = await build(BASE).inject({ method: "GET", url: "/health" });
    expect(hosted.headers["strict-transport-security"]).toBe(STRICT_TRANSPORT_SECURITY);
    await app!.close();

    const self = await build(SELF_HOSTED).inject({ method: "GET", url: "/health" });
    expect(self.headers["strict-transport-security"]).toBeUndefined();
    expect(self.headers["x-frame-options"]).toBe("DENY");
    await app!.close();

    const desktop = await build({ ...BASE, desktop: true, secureCookies: false }).inject({
      method: "GET",
      url: "/health",
    });
    expect(desktop.headers["strict-transport-security"]).toBeUndefined();
  });

  it("redirects plain http to https behind a trusted proxy in hosted mode", async () => {
    const server = build({ ...BASE, trustProxy: true });
    const res = await server.inject({
      method: "POST",
      url: "/v1/messages?x=1",
      headers: { host: "costgrid.example.com", "x-forwarded-proto": "http" },
      payload: {},
    });
    expect(res.statusCode).toBe(308);
    expect(res.headers["location"]).toBe("https://costgrid.example.com/v1/messages?x=1");

    // Already https at the proxy, or no proxy in the path at all: served.
    const tls = await server.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(tls.statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("uses the configured public address as the redirect target", async () => {
    const server = build({ ...BASE, trustProxy: true, publicUrl: "https://cg.example.com" });
    const res = await server.inject({
      method: "GET",
      url: "/console",
      headers: { host: "evil.example", "x-forwarded-proto": "http" },
    });
    expect(res.statusCode).toBe(308);
    expect(res.headers["location"]).toBe("https://cg.example.com/console");
  });

  it("ignores a forwarded protocol it was not told to trust, and never redirects self-hosted", async () => {
    const untrusted = await build(BASE).inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-proto": "http" },
    });
    expect(untrusted.statusCode).toBe(200);
    await app!.close();

    const self = await build({ ...SELF_HOSTED, trustProxy: true }).inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-proto": "http" },
    });
    expect(self.statusCode).toBe(200);
  });
});

describe("provider base URLs from the environment", () => {
  const saved = { ...process.env };
  const NAMES = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "AWS_BEDROCK_BASE_URL", "GOOGLE_VERTEX_BASE_URL"];

  beforeEach(() => {
    for (const name of [...NAMES, "COSTGRID_HOSTED", "COSTGRID_DESKTOP", "COSTGRID_TRUST_PROXY"]) {
      delete process.env[name];
    }
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it("refuses plain http, which would send the provider key in clear text", () => {
    for (const name of NAMES) {
      process.env[name] = "http://api.example.com";
      expect(() => loadConfig(), name).toThrow(new RegExp(`${name} must be https`));
      delete process.env[name];
    }
  });

  it("accepts https, and http to this machine for a local mock", () => {
    process.env["ANTHROPIC_BASE_URL"] = "https://gateway.example.com";
    process.env["OPENAI_BASE_URL"] = "http://127.0.0.1:9000";
    process.env["AWS_BEDROCK_BASE_URL"] = "http://localhost:9001";
    process.env["GOOGLE_VERTEX_BASE_URL"] = "http://[::1]:9002";
    const config = loadConfig();
    expect(config.providerBaseUrls.anthropic).toBe("https://gateway.example.com");
    expect(config.providerBaseUrls.openai).toBe("http://127.0.0.1:9000");
    expect(config.providerBaseUrls.bedrock).toBe("http://localhost:9001");
    expect(config.providerBaseUrls.vertex).toBe("http://[::1]:9002");
  });

  it("reads COSTGRID_TRUST_PROXY, off by default", () => {
    expect(loadConfig().trustProxy).toBeUndefined();
    process.env["COSTGRID_TRUST_PROXY"] = "true";
    expect(loadConfig().trustProxy).toBe(true);
    process.env["COSTGRID_TRUST_PROXY"] = "1";
    expect(loadConfig().trustProxy).toBe(true);
    process.env["COSTGRID_TRUST_PROXY"] = "10.0.0.0/8,127.0.0.1";
    expect(loadConfig().trustProxy).toBe("10.0.0.0/8,127.0.0.1");
  });
});
