import { deriveMasterKey, priceUsage, ZERO_USAGE } from "@costgrid/core";
import {
  AccountsRepository,
  Analytics,
  Anchors,
  CostGridRepository,
  generateAnchorKeys,
  ImportsRepository,
  openDatabase,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { adminKeyAccount, MemorySecretStore } from "../src/secret-store.js";
import { createServer } from "../src/server.js";

/**
 * The console routes that replaced command-line-only work: what changed,
 * advice and autopilot, anchors, backup, preflight and erasure.
 */

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";

const HOSTED: GatewayConfig = {
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

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-5",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200 },
};

describe("console operations", () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountsRepository;
  let repository: CostGridRepository;
  let app: FastifyInstance;
  let upstream: { url: string; headers: Record<string, string> }[];
  let tenantId: string;
  let cookie: string;
  let userId: string;

  const build = (config: GatewayConfig, secretStore?: MemorySecretStore) => {
    upstream = [];
    return createServer({
      config,
      secretStore,
      db,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
        upstream.push({ url: String(url), headers });
        const body = String(url).includes("openai") ? COMPLETION : MESSAGE;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
  };

  const signup = async (email = "owner@acme.test") => {
    const res = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email, name: "Owner", password: "a-sufficiently-long-password", organisation: "Acme" },
    });
    tenantId = res.json().tenantId;
    userId = res.json().user.id;
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    return res;
  };

  const get = (path: string) => app.inject({ method: "GET", url: path, headers: { cookie } });
  const send = (method: "POST" | "PUT" | "DELETE", path: string, payload?: unknown) =>
    app.inject({ method, url: path, headers: { cookie }, payload });

  const actions = () => accounts.audit.list(tenantId, {}).map((e) => e.action);

  /** A desktop install allows one account, so it needs a database of its own. */
  const desktop = async (secretStore?: MemorySecretStore) => {
    await app.close();
    db.close();
    db = openDatabase({ path: ":memory:" });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    repository = new CostGridRepository(db);
    app = build({ ...HOSTED, desktop: true }, secretStore);
    await signup("me@laptop.test");
  };

  /** Expensive short-answer traffic, enough for the advisor to propose routing. */
  const seedRoutable = () => {
    const now = Date.now();
    for (let i = 0; i < 120; i += 1) {
      const usage = { ...ZERO_USAGE, inputTokens: 40_000, outputTokens: 150 };
      const priced = priceUsage("claude-opus-5", usage);
      repository.recordCall({
        id: `c${i}`,
        tenantId,
        agentId: "classifier",
        department: "Support",
        provider: "anthropic",
        model: "claude-opus-5",
        startedAt: now - i * 60_000,
        durationMs: 10,
        streamed: false,
        usage,
        cost: priced.cost,
        priced: priced.priced,
        outcome: "ok",
        runId: `c${i}`,
        runDeclared: false,
      });
    }
  };

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    repository = new CostGridRepository(db);
    app = build(HOSTED);
    await signup();
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  // ------------------------------------------------------------ what changed

  it("reports what changed, and says when there is not enough history", async () => {
    const res = await get(`/console/${tenantId}/drift`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ days: 7, established: false, baselineCalls: 0, signals: [] });

    expect((await get(`/console/${tenantId}/drift?days=0`)).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/console/${tenantId}/drift` })).statusCode).toBe(401);
  });

  it("stops offering an invented tool as a dry run, and records who asked", async () => {
    const res = await send("POST", `/console/${tenantId}/drift/deny`, { agentId: "triage", tool: "db.drop" });
    expect(res.statusCode).toBe(201);

    const [policy] = repository.listPolicies(tenantId);
    expect(policy).toMatchObject({
      action: "monitor",
      scope: { kind: "agent", agentId: "triage" },
      rule: { kind: "tool-denylist", tools: ["db.drop"] },
    });
    expect(actions()).toContain("policy.created");

    expect((await send("POST", `/console/${tenantId}/drift/deny`, { agentId: "triage" })).statusCode).toBe(400);
  });

  // ------------------------------------------------------------------ advice

  it("lists proposals with money as decimal strings", async () => {
    seedRoutable();
    const res = await get(`/console/${tenantId}/advise?days=30`);
    expect(res.statusCode).toBe(200);

    const { proposals } = res.json();
    expect(proposals.length).toBeGreaterThan(0);
    const route = proposals.find((p: { kind: string }) => p.kind === "route-to-cheaper");
    expect(route).toBeDefined();
    expect(route.weightUsd).toMatch(/^\d+\.\d{6}$/);
    expect(route.backtest.amountUsd).toMatch(/^\d+\.\d{6}$/);
    expect(route.command).toMatch(/^costgrid policy route/);
  });

  it("installs a proposal as a dry run, from the server's own copy of it", async () => {
    seedRoutable();
    const { proposals } = (await get(`/console/${tenantId}/advise`)).json();
    const route = proposals.find((p: { kind: string }) => p.kind === "route-to-cheaper");

    const res = await send("POST", `/console/${tenantId}/advise/apply`, { command: route.command });
    expect(res.statusCode).toBe(201);

    const [policy] = repository.listPolicies(tenantId);
    expect(policy!.rule.kind).toBe("route");
    // Whatever the proposal said, it lands as a dry run.
    expect(policy!.action).toBe("monitor");
    expect(actions()).toContain("policy.created");
  });

  it("refuses a proposal that is no longer on the list", async () => {
    const res = await send("POST", `/console/${tenantId}/advise/apply`, {
      command: "costgrid policy route agent:ghost claude-haiku-4-5 --action monitor",
    });
    expect(res.statusCode).toBe(409);
    expect(repository.listPolicies(tenantId)).toHaveLength(0);
  });

  // --------------------------------------------------------------- autopilot

  it("switches autopilot on and off, within its own limits", async () => {
    expect((await get(`/console/${tenantId}/autopilot`)).json().settings.level).toBe("off");

    expect((await send("PUT", `/console/${tenantId}/autopilot`, { level: "always" })).statusCode).toBe(400);
    expect(
      (await send("PUT", `/console/${tenantId}/autopilot`, { level: "apply", maxImpactPct: 500 })).statusCode,
    ).toBe(400);

    const on = await send("PUT", `/console/${tenantId}/autopilot`, { level: "monitor", maxActions: 2 });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ level: "monitor", maxImpactPct: 50, maxActions: 2 });
    expect(actions()).toContain("autopilot.level-changed");
  });

  it("runs autopilot and undoes what it did", async () => {
    seedRoutable();
    expect((await send("POST", `/console/${tenantId}/autopilot/run`)).statusCode).toBe(409);

    await send("PUT", `/console/${tenantId}/autopilot`, { level: "monitor" });
    const run = await send("POST", `/console/${tenantId}/autopilot/run?days=30`);
    expect(run.statusCode).toBe(200);
    expect(run.json().taken).toHaveLength(1);
    expect(repository.listPolicies(tenantId)[0]!.action).toBe("monitor");
    expect(actions()).toContain("autopilot.ran");

    const undo = await send("POST", `/console/${tenantId}/autopilot/undo`);
    expect(undo.json()).toEqual({ rulesDisabled: 1 });
    expect(repository.listPolicies(tenantId)[0]!.enabled).toBe(false);
    expect(actions()).toContain("autopilot.undone");
  });

  // ----------------------------------------------------------------- anchors

  it("says anchoring is off when nothing is configured", async () => {
    const res = await get(`/console/${tenantId}/audit/anchors`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, receiverHost: null, undelivered: 0, recent: [] });
  });

  it("shows recent anchors and which never arrived", async () => {
    await app.close();
    const keys = generateAnchorKeys();
    app = build({ ...HOSTED, anchorUrl: "https://siem.acme.test/anchors", anchorKey: keys.privateKey });

    const anchors = new Anchors(db);
    anchors.create(tenantId, keys.privateKey);
    anchors.create(tenantId, keys.privateKey);
    anchors.markDelivered(tenantId, 1, 1_700_000_000_000);
    anchors.markFailed(tenantId, 2, "receiver returned 503");

    const res = await get(`/console/${tenantId}/audit/anchors`);
    expect(res.json()).toMatchObject({
      configured: true,
      receiverHost: "siem.acme.test",
      intervalMinutes: 60,
      undelivered: 1,
      lastDeliveredAt: 1_700_000_000_000,
    });
    expect(res.json().recent.map((a: { anchorNo: number }) => a.anchorNo)).toEqual([2, 1]);
    expect(res.json().recent[0].lastError).toBe("receiver returned 503");
  });

  // ------------------------------------------------------------------ backup

  it("refuses a backup on a shared deployment", async () => {
    const res = await get(`/console/${tenantId}/backup`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/every organisation/);
  });

  it("downloads a consistent copy on a desktop install", async () => {
    await desktop();

    const res = await get(`/console/${tenantId}/backup`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/costgrid-backup-\d{4}-\d{2}-\d{2}\.db/);
    expect(res.rawPayload.subarray(0, 15).toString()).toBe("SQLite format 3");
    expect(actions()).toContain("backup.downloaded");
  });

  // --------------------------------------------------------------- preflight

  it("tests a stored key with one real call and reports each stage", async () => {
    expect((await send("POST", `/console/${tenantId}/preflight/anthropic`)).json().error).toMatch(/Add one first/);
    expect((await send("POST", `/console/${tenantId}/preflight/nowhere`)).statusCode).toBe(400);

    await send("PUT", `/console/${tenantId}/credentials/anthropic`, { apiKey: "sk-ant-stored" });
    const res = await send("POST", `/console/${tenantId}/preflight/anthropic`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().steps.map((s: { name: string }) => s.name)).toEqual([
      "pricing", "route", "credentials", "request", "usage",
    ]);
    // The stored key, decrypted for this one call and sent nowhere else.
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers["x-api-key"]).toBe("sk-ant-stored");
    expect(actions()).toContain("preflight.ran");
  });

  it("accepts a CostGrid key as an OpenAI bearer token, which is what the setup wizard tells people", async () => {
    await send("PUT", `/console/${tenantId}/credentials/openai`, { apiKey: "sk-openai-stored" });
    const key = repository.createApiKey(tenantId, "my app").plaintext;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}` },
      payload: { model: "gpt-5", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(upstream[0]!.headers["authorization"]).toBe("Bearer sk-openai-stored");
  });

  // ------------------------------------------------------------------- erase

  it("erases an organisation only when its name is typed back", async () => {
    await send("PUT", `/console/${tenantId}/credentials/anthropic`, { apiKey: "sk-ant-stored" });
    repository.createApiKey(tenantId, "my app");

    const wrong = await send("DELETE", `/console/${tenantId}`, { confirm: "acme" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toContain('"Acme"');
    expect(repository.getTenant(tenantId)).toBeDefined();

    const res = await send("DELETE", `/console/${tenantId}`, { confirm: "Acme" });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThan(0);
    expect(res.json().accountRemoved).toBe(false);
    expect(repository.getTenant(tenantId)).toBeUndefined();
    expect(accounts.listCredentials(tenantId)).toHaveLength(0);

    // On a shared deployment the person keeps their account, with nothing in it.
    const me = await get("/console/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().organisations).toEqual([]);
  });

  it("erasing a desktop install removes the account too, so setup starts again", async () => {
    const keychain = new MemorySecretStore();
    await desktop(keychain);
    await keychain.set(adminKeyAccount(tenantId, "anthropic"), "sk-ant-admin-kept");
    await keychain.set(adminKeyAccount("someone-else", "anthropic"), "sk-ant-admin-other");

    const res = await send("DELETE", `/console/${tenantId}`, { confirm: "Acme" });
    expect(res.statusCode).toBe(200);
    expect(res.json().accountRemoved).toBe(true);
    expect(String(res.headers["set-cookie"])).toMatch(/costgrid_session=;/);
    // The organisation's admin key went with it; nobody else's did.
    expect(await keychain.get(adminKeyAccount(tenantId, "anthropic"))).toBeUndefined();
    expect(keychain.size).toBe(1);

    expect((await get("/console/me")).statusCode).toBe(401);
    expect(accounts.findUserByEmail("me@laptop.test")).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/console/setup" })).json().needsAccount).toBe(true);
    expect(userId).toBeTruthy();
  });

  it("keeps every one of these behind membership", async () => {
    const other = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email: "other@other.test", name: "Other", password: "a-sufficiently-long-password", organisation: "Other" },
    });
    const otherTenant = other.json().tenantId;

    for (const [method, path] of [
      ["GET", "drift"], ["GET", "advise"], ["GET", "autopilot"], ["GET", "audit/anchors"],
      ["GET", "backup"], ["POST", "preflight/anthropic"], ["POST", "autopilot/undo"],
    ] as const) {
      const res = await app.inject({ method, url: `/console/${otherTenant}/${path}`, headers: { cookie } });
      expect(res.statusCode, `${method} ${path}`).toBe(404);
    }
    expect((await send("DELETE", `/console/${otherTenant}`, { confirm: "Other" })).statusCode).toBe(404);
    expect(repository.getTenant(otherTenant)).toBeDefined();
  });
});
