import { deriveMasterKey, usd, ZERO_USAGE } from "@costgrid/core";
import {
  AccountsRepository,
  AgentsRepository,
  AlertsRepository,
  Analytics,
  ControlRepository,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
  SourcesRepository,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { KeyControl } from "../src/key-control.js";
import { adminKeyAccount, MemorySecretStore } from "../src/secret-store.js";
import { createServer } from "../src/server.js";

/**
 * View and control through the routes Limits calls, against a fake Anthropic
 * Admin API that keeps each key's status. What matters most: only keys that
 * were working are paused, a resume turns on only what CostGrid paused, the
 * admin key never leaves the request header, and a cap pauses once a month.
 */

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";
const ADMIN_KEY = "sk-ant-admin01-CONTROLTESTKEY-0123456789abcdef";
const HOSTED: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: {},
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  hosted: true,
  masterKeySecret: MASTER_SECRET,
  secureCookies: false,
  logLevel: "silent",
};

/** Key id to status, and to workspace; and every request seen. */
function fakeAnthropic(keys: Map<string, { status: string; workspace: string }>, seen: { method: string; path: string; key: string }[]) {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, key: headers["x-api-key"] ?? "" });
    const one = /^\/v1\/organizations\/api_keys\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const k = keys.get(decodeURIComponent(one[1]!));
      if (!k) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { status: string };
        if (body.status === "archived") throw new Error("CostGrid must never archive a key");
        k.status = body.status;
      }
      return new Response(JSON.stringify({ id: one[1], status: k.status }), { status: 200 });
    }
    if (url.pathname === "/v1/organizations/api_keys") {
      const ws = url.searchParams.get("workspace_id");
      const data = [...keys].filter(([, k]) => k.workspace === ws && k.status === url.searchParams.get("status")).map(([id, k]) => ({ id, status: k.status }));
      return new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("View and control", () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountsRepository;
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;
  let keys: Map<string, { status: string; workspace: string }>;
  let seen: { method: string; path: string; key: string }[];
  let store: MemorySecretStore;

  const call = (method: "GET" | "PUT" | "POST", url: string, payload?: object, as = cookie) =>
    app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });

  async function signup(email: string, organisation: string) {
    const res = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email, name: "Someone", password: "a-sufficiently-long-password", organisation },
    });
    return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, tenantId: res.json().tenantId as string, userId: res.json().user.id as string };
  }

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    keys = new Map([
      ["apikey_bot", { status: "active", workspace: "wrkspc_x" }],
      ["apikey_off", { status: "inactive", workspace: "wrkspc_x" }],
      ["apikey_ws1", { status: "active", workspace: "wrkspc_bot" }],
      ["apikey_ws2", { status: "inactive", workspace: "wrkspc_bot" }],
      ["apikey_other", { status: "active", workspace: "wrkspc_other" }],
    ]);
    seen = [];
    store = new MemorySecretStore();
    app = createServer({
      config: HOSTED,
      db,
      repository: new CostGridRepository(db),
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
      fetchImpl: fakeAnthropic(keys, seen),
      secretStore: store,
      alerts: new AlertsRepository(db, deriveMasterKey(MASTER_SECRET)),
    });
    ({ cookie, tenantId } = await signup("owner@acme.test", "Acme"));

    const agents = new AgentsRepository(db);
    const bot = agents.create(tenantId, { name: "Support bot" })!;
    const sources = new SourcesRepository(db);
    const today = new Date().toISOString().slice(0, 10);
    sources.upsertSources(
      tenantId,
      [
        { provider: "anthropic", kind: "key", id: "apikey_bot" },
        { provider: "anthropic", kind: "key", id: "apikey_off" },
        { provider: "anthropic", kind: "workspace", id: "wrkspc_bot" },
        { provider: "openai", kind: "project", id: "proj_bot" },
      ],
      { first: today, last: today },
    );
    for (const [provider, kind, id] of [
      ["anthropic", "key", "apikey_bot"],
      ["anthropic", "key", "apikey_off"],
      ["anthropic", "workspace", "wrkspc_bot"],
      ["openai", "project", "proj_bot"],
    ] as const) {
      agents.assign(tenantId, { provider, kind, id }, { agentId: bot, shared: false, by: "owner" });
    }
    new ImportsRepository(db).putRows(
      tenantId,
      "anthropic",
      { fromDay: today, toDay: today },
      [{ provider: "anthropic", day: today, model: "claude-opus-5", usage: { ...ZERO_USAGE, inputTokens: 1 }, requests: 0, costCatalog: usd("120"), priced: true, sourceKind: "key", sourceId: "apikey_bot" }],
      "admin-api",
    );
    sources.putAdminKey(tenantId, { provider: "anthropic", hint: "…cdef", expiresAt: null, createdAt: 1 });
    await store.set(adminKeyAccount(tenantId, "anthropic"), ADMIN_KEY);
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it("refuses to act on View, and says why", async () => {
    const state = (await call("GET", `/console/${tenantId}/control`)).json();
    expect(state).toMatchObject({ tier: "view", adminKeyConnected: true });
    const res = await call("POST", `/console/${tenantId}/agents/support-bot/pause`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("View and control");
    expect(seen).toEqual([]);
  });

  it("pauses only the keys that were working, resumes only those, and never shows the admin key", async () => {
    new ControlRepository(db).setTier(tenantId, "control");
    const state = (await call("GET", `/console/${tenantId}/control`)).json();
    expect(state.agents[0]).toMatchObject({
      id: "support-bot",
      spentUsd: "120.00",
      pausable: [expect.objectContaining({ id: "apikey_bot" }), expect.objectContaining({ id: "apikey_off" }), expect.objectContaining({ id: "wrkspc_bot" })],
      notPausable: [expect.objectContaining({ provider: "openai", id: "proj_bot" })],
    });

    const paused = await call("POST", `/console/${tenantId}/agents/support-bot/pause`);
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toEqual({ done: ["apikey_bot", "apikey_ws1"], failed: [], skipped: ["apikey_off"] });
    expect(keys.get("apikey_bot")!.status).toBe("inactive");
    expect(keys.get("apikey_ws1")!.status).toBe("inactive");
    expect(keys.get("apikey_other")!.status).toBe("active");

    // The owner turns one off at the provider for their own reasons; CostGrid's resume leaves it.
    const resumed = await call("POST", `/console/${tenantId}/agents/support-bot/resume`);
    expect(resumed.json().done.sort()).toEqual(["apikey_bot", "apikey_ws1"]);
    expect(keys.get("apikey_off")!.status).toBe("inactive");
    expect(keys.get("apikey_ws2")!.status).toBe("inactive");
    expect(keys.get("apikey_bot")!.status).toBe("active");

    expect(new Set(seen.map((s) => s.key))).toEqual(new Set([ADMIN_KEY]));
    const after = (await call("GET", `/console/${tenantId}/control`)).body;
    expect(after).not.toContain(ADMIN_KEY);
    expect(JSON.parse(after).history.map((h: { action: string; ok: boolean }) => [h.action, h.ok])).toHaveLength(4);
    const audit = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'control.%' ORDER BY rowid").all() as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(["control.paused", "control.resumed"]);
  });

  it("pauses an agent past its cap once a month, measures the stop, and lets the owner's resume stand", async () => {
    new ControlRepository(db).setTier(tenantId, "control");
    expect((await call("PUT", `/console/${tenantId}/agents/support-bot/cap`, { monthlyUsd: "0" })).statusCode).toBe(400);
    expect((await call("PUT", `/console/${tenantId}/agents/support-bot/cap`, { monthlyUsd: "500" })).statusCode).toBe(200);
    expect(keys.get("apikey_bot")!.status).toBe("active");

    // Lowering the cap below this month's $120 pauses at once.
    expect((await call("PUT", `/console/${tenantId}/agents/support-bot/cap`, { monthlyUsd: "100" })).statusCode).toBe(200);
    expect(keys.get("apikey_bot")!.status).toBe("inactive");
    const state = (await call("GET", `/console/${tenantId}/control`)).json();
    expect(state.agents[0].capUsd).toBe("100.00");
    const capPause = state.history.find((h: { reason: string; keyId: string }) => h.reason === "cap" && h.keyId === "apikey_bot");
    expect(capPause.reportLagMs).toBeGreaterThanOrEqual(0);
    expect(capPause.actionMs).toBeGreaterThanOrEqual(0);
    // One alert says both that the cap was reached and what CostGrid did about it.
    const alerts = db.prepare("SELECT kind, message FROM alerts ORDER BY occurred_at").all() as { kind: string; message: string }[];
    expect(alerts.map((a) => a.kind)).toEqual(["cap-reached"]);
    expect(alerts[0]!.message).toContain("CostGrid paused 2 of its Claude keys");

    await call("POST", `/console/${tenantId}/agents/support-bot/resume`);
    expect(keys.get("apikey_bot")!.status).toBe("active");
    await new KeyControl({ db, audit: accounts.audit, secretStore: store, fetchImpl: fakeAnthropic(keys, seen) }).checkCaps();
    expect(keys.get("apikey_bot")!.status).toBe("active");
  });

  it("is for owners, says plainly when there is no admin key, and stays inside the organisation", async () => {
    new ControlRepository(db).setTier(tenantId, "control");
    const member = await signup("member@acme.test", "Personal");
    accounts.addMember(tenantId, member.userId, "member");
    expect((await call("GET", `/console/${tenantId}/control`, undefined, member.cookie)).statusCode).toBe(200);
    expect((await call("POST", `/console/${tenantId}/agents/support-bot/pause`, undefined, member.cookie)).statusCode).toBe(403);
    const other = await signup("other@other.test", "Other");
    expect((await call("POST", `/console/${tenantId}/agents/support-bot/pause`, undefined, other.cookie)).statusCode).toBe(404);
    expect((await call("PUT", `/console/${tenantId}/agents/nobody/cap`, { monthlyUsd: "10" })).statusCode).toBe(404);

    const forged = await app.inject({
      method: "POST",
      url: `/console/${tenantId}/agents/support-bot/pause`,
      headers: { cookie, origin: "https://evil.test", host: "costgrid.test" },
    });
    expect(forged.statusCode).toBe(403);
    expect(seen).toEqual([]);

    await store.delete(adminKeyAccount(tenantId, "anthropic"));
    const res = await call("POST", `/console/${tenantId}/agents/support-bot/pause`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("Claude admin key");
    expect(seen).toEqual([]);
  });

  it("retries a cap pause that failed, and resumes keys after the tier or the agent is gone", async () => {
    const control = new ControlRepository(db);
    control.setTier(tenantId, "control");
    // Anthropic refuses the first attempt.
    let refuse = true;
    const flaky = (async (input: unknown, init?: RequestInit) => {
      if (init?.method === "POST" && refuse) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 });
      return fakeAnthropic(keys, seen)(input as string, init);
    }) as unknown as typeof fetch;
    const kc = () => new KeyControl({ db, audit: accounts.audit, secretStore: store, fetchImpl: flaky });
    control.setCap(tenantId, "support-bot", usd("100"));
    await kc().checkCaps();
    expect(keys.get("apikey_bot")!.status).toBe("active");
    refuse = false;
    await kc().checkCaps();
    expect(keys.get("apikey_bot")!.status).toBe("inactive");

    // Back to View: the pause can still be undone.
    control.setTier(tenantId, "view");
    const state = (await call("GET", `/console/${tenantId}/control`)).json();
    expect(state.agents[0].paused.map((p: { keyId: string }) => p.keyId).sort()).toEqual(["apikey_bot", "apikey_ws1"]);
    expect((await call("POST", `/console/${tenantId}/agents/support-bot/pause`)).statusCode).toBe(403);
    expect((await call("POST", `/console/${tenantId}/agents/support-bot/resume`)).statusCode).toBe(200);
    expect(keys.get("apikey_bot")!.status).toBe("active");

    // Paused, then the agent removed: still listed, still resumable.
    control.setTier(tenantId, "control");
    await call("POST", `/console/${tenantId}/agents/support-bot/pause`);
    new AgentsRepository(db).remove(tenantId, "support-bot");
    const after = (await call("GET", `/console/${tenantId}/control`)).json();
    expect(after.orphaned).toEqual([expect.objectContaining({ id: "support-bot" })]);
    expect((await call("POST", `/console/${tenantId}/agents/support-bot/pause`)).statusCode).toBe(404);
    await call("POST", `/console/${tenantId}/agents/support-bot/resume`);
    expect(keys.get("apikey_bot")!.status).toBe("active");
  });

  it("does not fill the audit log when a capped agent has nothing to pause", async () => {
    const control = new ControlRepository(db);
    control.setTier(tenantId, "control");
    for (const id of ["apikey_bot", "apikey_off"]) {
      new AgentsRepository(db).assign(tenantId, { provider: "anthropic", kind: "key", id }, { agentId: null, shared: false, by: "owner" });
    }
    new AgentsRepository(db).assign(tenantId, { provider: "anthropic", kind: "workspace", id: "wrkspc_bot" }, { agentId: null, shared: false, by: "owner" });
    // Its spend now sits on no agent, so give it some of its own through the OpenAI project.
    const today = new Date().toISOString().slice(0, 10);
    new ImportsRepository(db).putRows(
      tenantId,
      "openai",
      { fromDay: today, toDay: today },
      [{ provider: "openai", day: today, model: "gpt-6", usage: { ...ZERO_USAGE, inputTokens: 1 }, requests: 0, costCatalog: usd("50"), priced: true, sourceKind: "project", sourceId: "proj_bot" }],
      "admin-api",
    );
    control.setCap(tenantId, "support-bot", usd("10"));
    const kc = new KeyControl({ db, audit: accounts.audit, secretStore: store, fetchImpl: fakeAnthropic(keys, seen) });
    await kc.checkCaps();
    await kc.checkCaps();
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'control.paused'").get()).toEqual({ n: 0 });
    expect(seen).toEqual([]);
  });
});
