import { deriveMasterKey } from "@costgrid/core";
import {
  AccountsRepository,
  AlertsRepository,
  Analytics,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AlertNotice } from "../src/alerts.js";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The Limits and Results screens, driven end to end through the console and
 * the proxy: stopping an agent, alerts, the reasoning cap, and the evidence
 * pack. The one property every test here leans on: a refused call never
 * reaches the provider.
 */

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";
const WEBHOOK = "https://hooks.example.test/services/abc/def/ghij";

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
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  usage: { input_tokens: 1_000, output_tokens: 500 },
};

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-6-sol",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1_000, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } },
};

describe("limits, stop and alerts", () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountsRepository;
  let repository: CostGridRepository;
  let app: FastifyInstance;
  let upstream: string[];
  let webhooks: Record<string, unknown>[];
  let notices: AlertNotice[];
  let tenantId: string;
  let cookie: string;
  let key: string;

  const get = (path: string) => app.inject({ method: "GET", url: path, headers: { cookie } });
  const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, payload?: unknown) =>
    app.inject({ method, url: path, headers: { cookie }, payload });

  const message = (agent: string, body: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": key, "x-costgrid-agent": agent, "x-costgrid-department": "Support" },
      payload: { model: "claude-opus-5-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...body },
    });

  /** Lets queued deliveries finish before asserting on them. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    const masterKey = deriveMasterKey(MASTER_SECRET);
    accounts = new AccountsRepository(db, masterKey);
    repository = new CostGridRepository(db);
    upstream = [];
    webhooks = [];
    notices = [];
    app = createServer({
      config: HOSTED,
      db,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
      alerts: new AlertsRepository(db, masterKey),
      onAlert: (notice) => notices.push(notice),
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        if (String(url).startsWith("https://hooks.example.test")) {
          webhooks.push(JSON.parse(String(init?.body)));
          return new Response("ok", { status: 200 });
        }
        upstream.push(String(url));
        const body = String(url).includes("openai") ? COMPLETION : MESSAGE;
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });

    const res = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email: "owner@acme.test", name: "Owner", password: "a-sufficiently-long-password", organisation: "Acme" },
    });
    tenantId = res.json().tenantId;
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    await send("PUT", `/console/${tenantId}/credentials/anthropic`, { apiKey: "sk-ant-stored" });
    await send("PUT", `/console/${tenantId}/credentials/openai`, { apiKey: "sk-openai-stored" });
    key = repository.createApiKey(tenantId, "app").plaintext;
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it("stops one agent at once, leaves the others alone, and resumes keeping the record", async () => {
    expect((await message("support-bot")).statusCode).toBe(200);

    const stop = await send("POST", `/console/${tenantId}/stop`, {
      scope: { kind: "agent", agentId: "support-bot" },
      reason: "looping on refunds",
    });
    expect(stop.statusCode).toBe(201);
    expect((await send("POST", `/console/${tenantId}/stop`, { scope: { kind: "agent", agentId: "support-bot" } })).statusCode).toBe(409);

    upstream = [];
    const refused = await message("support-bot");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.type).toBe("costgrid_policy_blocked");
    expect(refused.json().error.message).toMatch(/stopped by an operator/);
    expect(upstream).toEqual([]); // never reached the provider

    expect((await message("billing-bot")).statusCode).toBe(200);
    expect(upstream).toHaveLength(1);

    expect((await send("POST", `/console/${tenantId}/resume/${stop.json().id}`)).statusCode).toBe(200);
    expect((await message("support-bot")).statusCode).toBe(200);

    const rules = (await get(`/console/${tenantId}/limits`)).json().rules;
    const record = rules.find((r: { id: string }) => r.id === stop.json().id);
    expect(record).toMatchObject({ enabled: false, owner: "owner@acme.test", reason: "looping on refunds", fired: { block: 1 } });
    expect(record.history.map((h: { action: string }) => h.action)).toEqual(["policy.created", "policy.disabled"]);

    await settle();
    expect(notices.map((n) => n.kind)).toEqual(["stopped"]);
  });

  it("only owners may stop, set limits or change where alerts go", async () => {
    const member = accounts.signUp({
      email: "m@acme.test",
      name: "M",
      password: "another-long-password",
      organisation: "Elsewhere",
    }).user;
    accounts.addMember(tenantId, member.id, "member");
    const session = accounts.createSession(member.id);
    const asMember = (path: string, payload: unknown) =>
      app.inject({ method: "POST", url: path, headers: { cookie: `costgrid_session=${session.token}` }, payload });
    expect((await asMember(`/console/${tenantId}/stop`, { scope: { kind: "tenant" } })).statusCode).toBe(403);
    expect((await asMember(`/console/${tenantId}/limits`, { kind: "run-steps", limit: 5, scope: { kind: "tenant" } })).statusCode).toBe(403);
  });

  it("alerts once when a budget refuses calls, however many calls it refuses", async () => {
    await send("PUT", `/console/${tenantId}/alerts`, { webhookUrl: WEBHOOK, desktop: true });
    const created = await send("POST", `/console/${tenantId}/limits`, {
      kind: "budget",
      window: "month",
      limitUsd: "0.000001",
      scope: { kind: "agent", agentId: "support-bot" },
      action: "block",
      owner: "finance@acme.test",
    });
    expect(created.statusCode).toBe(201);

    expect((await message("support-bot")).statusCode).toBe(200); // spends past the tiny cap
    for (let i = 0; i < 5; i += 1) expect((await message("support-bot")).statusCode).toBe(403);
    await settle();

    expect(webhooks).toHaveLength(1);
    expect(String(webhooks[0]!["text"])).toMatch(/refused/);
    expect((webhooks[0]!["costgrid"] as { kind: string }).kind).toBe("blocked");
    const listed = (await get(`/console/${tenantId}/limits`)).json();
    expect(listed.alerts).toHaveLength(1);
    expect(listed.alerts[0].deliveredAt).not.toBeNull();
    // The address itself never comes back.
    expect(JSON.stringify(listed)).not.toContain("ghij/");
    expect(listed.alertSettings.webhookHint).toBe("hooks.example.test/…ghij");
  });

  it("starts a new limit measuring unless told otherwise, and validates what it is given", async () => {
    const ok = await send("POST", `/console/${tenantId}/limits`, { kind: "run-steps", limit: 40, scope: { kind: "tenant" } });
    expect(ok.statusCode).toBe(201);
    expect(repository.listPolicies(tenantId)[0]).toMatchObject({ action: "monitor", rule: { kind: "run-steps", limit: 40 } });

    const bad = async (payload: Record<string, unknown>) =>
      (await send("POST", `/console/${tenantId}/limits`, { scope: { kind: "tenant" }, ...payload })).json().error;
    expect(await bad({ kind: "budget", window: "month", limitUsd: "-5" })).toMatch(/number of dollars/);
    expect(await bad({ kind: "budget", window: "week", limitUsd: "5" })).toMatch(/day or a month/);
    expect(await bad({ kind: "budget", window: "day", limitUsd: "5", fallbackModel: "made-up" })).toMatch(/price/);
    expect(await bad({ kind: "max-reasoning" })).toMatch(/effort level/);
    expect(await bad({ kind: "stop" })).toMatch(/cannot be set/);
    expect(await bad({ kind: "run-steps", limit: 4, scope: undefined })).toBeDefined();
  });

  it("refuses a request that asks for more reasoning than the cap allows", async () => {
    await send("POST", `/console/${tenantId}/limits`, {
      kind: "max-reasoning",
      effort: "high",
      scope: { kind: "tenant" },
      action: "block",
    });
    upstream = [];
    const refused = await message("support-bot", { output_config: { effort: "max" } });
    expect(refused.statusCode).toBe(403);
    expect(upstream).toEqual([]);
    expect((await message("support-bot", { output_config: { effort: "medium" } })).statusCode).toBe(200);
    // Says nothing about effort: not judged.
    expect((await message("support-bot")).statusCode).toBe(200);
  });

  it("records what reasoning each call asked for and what OpenAI billed for it", async () => {
    await message("support-bot", { output_config: { effort: "high" } });
    await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}`, "x-costgrid-agent": "planner" },
      payload: { model: "gpt-6-sol", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] },
    });
    const rows = db
      .prepare("SELECT model, reasoning_tokens AS r, reasoning_requested AS q FROM calls ORDER BY model")
      .all();
    expect(rows).toEqual([
      { model: "claude-opus-5-5", r: null, q: "effort:high" },
      { model: "gpt-6-sol", r: 700, q: "effort:high" },
    ]);

    const results = (await get(`/console/${tenantId}/results`)).json();
    const gpt = results.reasoning.byModel.find((m: { model: string }) => m.model === "gpt-6-sol");
    expect(gpt).toMatchObject({ reportedCalls: 1, reasoningTokens: 700 });
    expect(Number(gpt.reasoningCostUsd)).toBeGreaterThan(0);
  });

  it("sends a test alert on request and says whether it arrived", async () => {
    const noAddress = (await send("POST", `/console/${tenantId}/alerts/test`)).json();
    expect(noAddress).toMatchObject({ delivered: false, webhookConfigured: false });

    await send("PUT", `/console/${tenantId}/alerts`, { webhookUrl: WEBHOOK });
    const sent = (await send("POST", `/console/${tenantId}/alerts/test`)).json();
    expect(sent).toMatchObject({ delivered: true });
    expect((await send("PUT", `/console/${tenantId}/alerts`, { webhookUrl: "http://insecure.test/x" })).statusCode).toBe(400);
    expect(accounts.audit.list(tenantId, {}).map((e) => e.action)).toContain("alerts.configured");
  });

  it("keeps entered costs apart and puts everything in a downloadable evidence pack", async () => {
    await message("support-bot");
    const added = await send("POST", `/console/${tenantId}/fixed-costs`, {
      label: "Helpdesk licence",
      category: "subscriptions",
      monthlyUsd: "400",
    });
    expect(added.statusCode).toBe(201);
    expect((await send("POST", `/console/${tenantId}/fixed-costs`, { label: "x", category: "nope", monthlyUsd: "1" })).statusCode).toBe(400);

    const full = (await get(`/console/${tenantId}/results`)).json().fullCost;
    expect(full.enteredUsd).toBe("400.000000");
    expect(Number(full.fullCostUsd)).toBeCloseTo(400 + Number(full.meteredUsd), 6);

    const pack = await get(`/console/${tenantId}/evidence`);
    expect(pack.statusCode).toBe(200);
    expect(pack.headers["content-disposition"]).toMatch(/costgrid-evidence-\d{4}-\d{2}\.json/);
    const body = pack.json();
    expect(body.kind).toBe("costgrid-evidence-pack");
    expect(body.statement.enteredUsd).toBe("400.000000");
    expect(body.auditLog.verification.intact).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-ant-stored");

    expect((await send("DELETE", `/console/${tenantId}/fixed-costs/${added.json().id}`)).json()).toEqual({ removed: true });
  });
});

describe("runaway runs", () => {
  it("warns mid-run when a run has spent several times what the agent's runs usually do", async () => {
    const { RunawayWatch } = await import("../src/alerts.js");
    const { usd } = await import("@costgrid/core");
    const db = openDatabase({ path: ":memory:" });
    const repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    const now = Date.now();
    const cost = (total: bigint) => ({ input: total, output: 0n, cacheWrite: 0n, cacheRead: 0n, total });
    for (let i = 0; i < 25; i += 1) {
      repository.recordCall({
        id: `c${i}`, tenantId: "t1", agentId: "planner", department: "Ops", provider: "anthropic",
        model: "claude-haiku-4-5", startedAt: now - i * 60_000, durationMs: 1, streamed: false,
        usage: { inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0 },
        cost: cost(usd("0.40")), priced: true, outcome: "ok", runId: `r${i}`, runDeclared: true,
      });
    }
    const watch = new RunawayWatch(db);
    // Usual runs cost $0.40; three times that is $1.20.
    expect(watch.check("t1", "planner", "live", usd("1.00"), now)).toBeUndefined();
    const alert = watch.check("t1", "planner", "live", usd("1.50"), now);
    expect(alert).toMatchObject({ kind: "runaway-run", dedupeKey: "runaway:live" });
    expect(alert!.message).toMatch(/still running/);
    // Too few runs to know what usual is: say nothing.
    expect(watch.check("t1", "newcomer", "x", usd("50"), now)).toBeUndefined();
    db.close();
  });
});
