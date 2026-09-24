import { join } from "node:path";
import { deriveMasterKey } from "@costgrid/core";
import {
  AccountsRepository,
  Analytics,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
  SignupClosedError,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appDataDir, type GatewayConfig, loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";

// ------------------------------------------------------------ configuration

describe("desktop mode configuration", () => {
  const saved = { ...process.env };
  const clean = [
    "COSTGRID_DESKTOP", "COSTGRID_HOSTED", "COSTGRID_HOST", "COSTGRID_MASTER_KEY_SOURCE",
    "COSTGRID_MASTER_KEY", "COSTGRID_DB", "COSTGRID_ALLOW_ANONYMOUS", "COSTGRID_SECURE_COOKIES",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_BEDROCK_CREDENTIAL", "GOOGLE_SERVICE_ACCOUNT_JSON",
  ];

  beforeEach(() => {
    for (const name of clean) delete process.env[name];
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  const fromKeychain = () => MASTER_SECRET;

  it("runs the control plane with the key from the keychain, and nothing from .env", () => {
    process.env["COSTGRID_DESKTOP"] = "true";
    const config = loadConfig({ readKeychain: fromKeychain });

    expect(config.desktop).toBe(true);
    expect(config.hosted).toBe(true);
    expect(config.allowAnonymous).toBe(false);
    expect(config.masterKeySecret).toBe(MASTER_SECRET);
    expect(config.masterKeySource).toBe("keychain");
    expect(config.secureCookies).toBe(false);
    expect(config.databasePath).toBe(join(appDataDir(), "CostGrid", "costgrid.db"));
  });

  it("only listens on this machine", () => {
    process.env["COSTGRID_DESKTOP"] = "true";
    process.env["COSTGRID_HOST"] = "0.0.0.0";
    expect(() => loadConfig({ readKeychain: fromKeychain })).toThrow(/only listens on this machine/);
  });

  it("cannot be combined with COSTGRID_HOSTED=false", () => {
    process.env["COSTGRID_DESKTOP"] = "true";
    process.env["COSTGRID_HOSTED"] = "false";
    expect(() => loadConfig({ readKeychain: fromKeychain })).toThrow(/COSTGRID_HOSTED=false/);
  });

  it("refuses two sources for the master key", () => {
    process.env["COSTGRID_DESKTOP"] = "true";
    process.env["COSTGRID_MASTER_KEY"] = MASTER_SECRET;
    expect(() => loadConfig({ readKeychain: fromKeychain })).toThrow(/Use one or the other/);
  });

  it("says how to create the key when the keychain has none", () => {
    process.env["COSTGRID_DESKTOP"] = "true";
    expect(() => loadConfig({ readKeychain: () => undefined })).toThrow(/npm run desktop:init/);
  });

  it("refuses anonymous calls", () => {
    process.env["COSTGRID_DESKTOP"] = "true";
    process.env["COSTGRID_ALLOW_ANONYMOUS"] = "true";
    expect(() => loadConfig({ readKeychain: fromKeychain })).toThrow(/cannot be true in hosted mode/);
  });

  it("leaves self-hosted mode exactly as it was, without touching the keychain", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-operator";
    const readKeychain = vi.fn(fromKeychain);
    const config = loadConfig({ readKeychain });

    expect(config.desktop).toBe(false);
    expect(config.hosted).toBe(false);
    expect(config.masterKeySource).toBe("env");
    expect(config.databasePath).toBe("./costgrid.db");
    expect(readKeychain).not.toHaveBeenCalled();
  });

  it("can take the key from the keychain for a hosted deployment too", () => {
    process.env["COSTGRID_HOSTED"] = "true";
    process.env["COSTGRID_MASTER_KEY_SOURCE"] = "keychain";
    const config = loadConfig({ readKeychain: fromKeychain });

    expect(config.desktop).toBe(false);
    expect(config.masterKeySecret).toBe(MASTER_SECRET);
    expect(config.secureCookies).toBe(true);
  });
});

// ------------------------------------------------------------- one account

const DESKTOP: GatewayConfig = {
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
  desktop: true,
  masterKeySecret: MASTER_SECRET,
  masterKeySource: "keychain",
  secureCookies: false,
  publicUrl: undefined,
  anchorUrl: undefined,
  anchorKey: undefined,
  anchorIntervalMinutes: 60,
  logLevel: "silent",
};

const MESSAGE = {
  id: "msg_1",
  model: "claude-opus-5",
  stop_reason: "end_turn",
  usage: { input_tokens: 1_000, output_tokens: 500 },
};

describe("a desktop install", () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountsRepository;
  let repository: CostGridRepository;
  let app: FastifyInstance;
  let upstream: Record<string, string>[];

  const build = (config: GatewayConfig) => {
    upstream = [];
    return createServer({
      config,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        upstream.push({ ...((init?.headers ?? {}) as Record<string, string>) });
        return new Response(JSON.stringify(MESSAGE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
  };

  const signup = (email: string) =>
    app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email, name: "Me", password: "a-sufficiently-long-password", organisation: "My laptop" },
    });

  const setup = async () => (await app.inject({ method: "GET", url: "/console/setup" })).json();

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    repository = new CostGridRepository(db);
    app = build(DESKTOP);
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it("creates its one account on first run and closes signup behind it", async () => {
    expect(await setup()).toEqual({ singleAccount: true, needsAccount: true, keychain: true });
    expect((await signup("me@laptop.test")).statusCode).toBe(201);
    expect(await setup()).toEqual({ singleAccount: true, needsAccount: false, keychain: true });

    const second = await signup("someone-else@laptop.test");
    expect(second.statusCode).toBe(403);
    expect(second.json().error).toMatch(/already has its account/);
  });

  it("enforces the one account inside the transaction, not just at the route", () => {
    const input = { name: "Me", password: "a-sufficiently-long-password", organisation: "Laptop" };
    accounts.signUp({ ...input, email: "a@laptop.test" }, { onlyAccount: true });
    expect(() => accounts.signUp({ ...input, email: "b@laptop.test" }, { onlyAccount: true })).toThrow(
      SignupClosedError,
    );
  });

  it("leaves multi-tenant signup open, and does not say whether anyone has signed up", async () => {
    await app.close();
    app = build({ ...DESKTOP, desktop: false });

    expect((await signup("one@acme.test")).statusCode).toBe(201);
    expect((await signup("two@other.test")).statusCode).toBe(201);
    expect(await setup()).toEqual({ singleAccount: false });
  });

  it("accepts a CostGrid key sent the way the Anthropic SDK sends api_key, and never forwards it", async () => {
    const created = await signup("me@laptop.test");
    const tenantId = created.json().tenantId as string;
    const cookie = String(created.headers["set-cookie"]).split(";")[0]!;

    await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/credentials/anthropic`,
      headers: { cookie },
      payload: { apiKey: "sk-ant-stored-in-the-console" },
    });
    const costgridKey = repository.createApiKey(tenantId, "my app").plaintext;

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": costgridKey },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!["x-api-key"]).toBe("sk-ant-stored-in-the-console");
    expect(JSON.stringify(upstream[0])).not.toContain(costgridKey);
  });

  it("does not treat a provider key in x-api-key as a CostGrid key", async () => {
    await signup("me@laptop.test");
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "sk-ant-someone-pasted-the-real-key" },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(401);
    expect(upstream).toHaveLength(0);
  });

  it("keeps api_key=\"unused\" working in self-hosted anonymous mode", async () => {
    await app.close();
    app = build({
      ...DESKTOP,
      desktop: false,
      hosted: false,
      allowAnonymous: true,
      masterKeySecret: undefined,
      providerKeys: { anthropic: "sk-ant-operator" },
    });
    repository.createTenant("Local", "local");

    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "unused" },
      payload: { model: "claude-opus-5", max_tokens: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(upstream[0]!["x-api-key"]).toBe("sk-ant-operator");
  });
});
