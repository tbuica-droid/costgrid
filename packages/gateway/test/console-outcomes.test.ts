import { deriveMasterKey, priceUsage, ZERO_USAGE } from "@costgrid/core";
import { AccountsRepository, AgentsRepository, Analytics, CostGridRepository, ImportsRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/** "Did the jobs get done?" and the matching switch, through the routes the console calls. */

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";
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
const HOUR = 3_600_000;

describe("outcome routes", () => {
  let db: ReturnType<typeof openDatabase>;
  let accounts: AccountsRepository;
  let repository: CostGridRepository;
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;
  let seq = 0;

  const call = (method: "GET" | "PUT", url: string, payload?: object, as = cookie) =>
    app.inject({ method, url, headers: { cookie: as }, ...(payload ? { payload } : {}) });

  async function signup(email: string, organisation: string) {
    const res = await app.inject({
      method: "POST",
      url: "/console/signup",
      payload: { email, name: "Someone", password: "a-sufficiently-long-password", organisation },
    });
    return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, tenantId: res.json().tenantId as string, userId: res.json().user.id as string };
  }

  const record = (o: { at: number; task?: string; stop?: string; run?: string }) => {
    const usage = { ...ZERO_USAGE, inputTokens: 1_000_000 };
    const priced = priceUsage("claude-haiku-4-5", usage);
    const id = `c${(seq += 1)}`;
    repository.recordCall({
      id, tenantId, agentId: "support-bot", department: "Ops", provider: "anthropic", model: "claude-haiku-4-5",
      startedAt: o.at, durationMs: 1000, streamed: false, usage, cost: priced.cost, priced: true, outcome: "ok",
      stopReason: o.stop ?? "end_turn", runId: o.run ?? id, runDeclared: o.run !== undefined, runDepth: 0,
      ...(o.task ? { taskKey: o.task, taskSource: "header" as const } : {}),
    });
  };

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    accounts = new AccountsRepository(db, deriveMasterKey(MASTER_SECRET));
    repository = new CostGridRepository(db);
    app = createServer({
      config: HOSTED,
      db,
      repository,
      analytics: new Analytics(db),
      accounts,
      imports: new ImportsRepository(db),
      fingerprintKey: Buffer.alloc(32, 1),
    });
    ({ cookie, tenantId } = await signup("owner@acme.test", "Acme"));
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it("reports each agent's jobs, inferred apart from reported, with the reasons", async () => {
    new AgentsRepository(db).create(tenantId, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    const old = Date.now() - 10 * 24 * HOUR; // past the 7-day waiting period
    record({ at: old, task: "ticket-1" });
    record({ at: old + HOUR, task: "ticket-2", stop: "max_tokens" });
    record({ at: old + 2 * HOUR }); // no identity
    record({ at: Date.now() - HOUR, task: "ticket-3" }); // still waiting

    const res = await call("GET", `/console/${tenantId}/outcomes?days=30`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fingerprint).toEqual({ available: true, enabled: true });
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      id: "support-bot",
      name: "Support bot",
      purposeId: "support",
      purposeVersion: "2",
      presetLabel: "Customer support",
      evidence: "medium",
      needsUpgrade: false,
      counts: { finished: 1, failed: 1, abandoned: 0, waiting: 1, unknown: 1 },
      reported: { finished: 0, failed: 0 },
      reasons: { cutOff: 1, handedOff: 0, askedAgain: 0 },
      mostlyInferred: true,
      identity: { header: 3, fingerprint: 0, none: 1 },
    });
    expect(body.agents[0].summary.costPerFinishedUsd).toMatch(/^\d+\.\d{6}$/);
    expect(body.agents[0].summary).toMatchObject({
      verdict: "mostly-failures",
      failureCostShare: "66.7", // the job that can't be told counts as not finished
      spread: { ratio: "1.0" },
      personRatio: null,
      spendNoSuccesses: false,
    });
    expect(body.agents[0].person).toBeNull();
    expect(body.noOutcomeData).toEqual([]);
    expect(body.retentionNote).toBe(false);
    expect((await call("GET", `/console/${tenantId}/outcomes?days=0`)).statusCode).toBe(400);
  });

  it("lets members read and only owners change the matching switch", async () => {
    const member = await signup("member@acme.test", "Personal");
    accounts.addMember(tenantId, member.userId, "member");
    expect((await call("GET", `/console/${tenantId}/outcomes`, undefined, member.cookie)).statusCode).toBe(200);
    expect((await call("GET", `/console/${tenantId}/outcome-settings`, undefined, member.cookie)).json()).toEqual({
      available: true,
      enabled: true,
    });
    expect((await call("PUT", `/console/${tenantId}/outcome-settings`, { enabled: false }, member.cookie)).statusCode).toBe(403);

    expect((await call("PUT", `/console/${tenantId}/outcome-settings`, { enabled: "no" })).statusCode).toBe(400);
    expect((await call("PUT", `/console/${tenantId}/outcome-settings`, { enabled: false })).json()).toEqual({
      available: true,
      enabled: false,
    });
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'outcomes.matching'").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toEqual({ enabled: false, codesDeleted: 0 });

    const other = await signup("other@other.test", "Other");
    expect((await call("GET", `/console/${tenantId}/outcomes`, undefined, other.cookie)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/console/${tenantId}/outcomes` })).statusCode).toBe(401);
    const forged = await app.inject({
      method: "PUT",
      url: `/console/${tenantId}/outcome-settings`,
      headers: { cookie, origin: "https://evil.test", host: "costgrid.test" },
      payload: { enabled: true },
    });
    expect(forged.statusCode).toBe(403);
  });

  it("takes the owner's person cost and job counts, and shows them as estimates beside the figures", async () => {
    const agents = new AgentsRepository(db);
    agents.create(tenantId, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    record({ at: Date.now() - 10 * 24 * HOUR, task: "ticket-1" });

    const url = `/console/${tenantId}/agents/support-bot/person-cost`;
    expect((await call("PUT", url, { minutes: 10, hourlyUsd: "abc" })).statusCode).toBe(400);
    expect((await call("PUT", url, { minutes: 1.5, hourlyUsd: "30" })).statusCode).toBe(400);
    expect((await call("PUT", url, { minutes: 0, hourlyUsd: "30" })).statusCode).toBe(400);
    expect((await call("PUT", `/console/${tenantId}/agents/nobody/person-cost`, { minutes: 10, hourlyUsd: "30" })).statusCode).toBe(404);
    expect((await call("PUT", url, { minutes: 10, hourlyUsd: "30" })).statusCode).toBe(200);

    let agent = (await call("GET", `/console/${tenantId}/outcomes`)).json().agents[0];
    expect(agent.person).toEqual({ minutes: 10, hourlyUsd: "30.00", costPerJobUsd: "5.00" });
    expect(agent.summary.personRatio).toMatch(/^0\.\d\d$/);
    expect(agent.summary.verdict).toBe("steady");

    expect((await call("PUT", url, { clear: true })).statusCode).toBe(200);
    agent = (await call("GET", `/console/${tenantId}/outcomes`)).json().agents[0];
    expect(agent.person).toBeNull();

    const writer = agents.create(tenantId, { name: "Writer" })!;
    db.prepare(
      `INSERT INTO usage_sources (tenant_id, provider, source_kind, source_id, first_day, last_day, created_at, agent_id, assigned_by)
       VALUES (?, 'openai', 'project', 'proj_w', '2026-09-01', '2026-09-30', 0, ?, 'owner')`,
    ).run(tenantId, writer);
    const counts = `/console/${tenantId}/agents/${writer}/job-counts`;
    expect((await call("PUT", `${counts}/2026-9`, { finished: 3 })).statusCode).toBe(400);
    expect((await call("PUT", `${counts}/2999-01`, { finished: 3 })).statusCode).toBe(400);
    expect((await call("PUT", `${counts}/2026-09`, { finished: -3 })).statusCode).toBe(400);
    expect((await call("PUT", `${counts}/2026-09`, { finished: 3, notFinished: "2" })).statusCode).toBe(400);
    expect((await call("PUT", `${counts}/2026-09`, { finished: 0 })).statusCode).toBe(200);
    const only = (await call("GET", `/console/${tenantId}/outcomes`)).json().noOutcomeData;
    expect(only).toEqual([
      expect.objectContaining({
        id: writer,
        counts: [{ month: "2026-09", finished: 0, notFinished: null }],
        latest: expect.objectContaining({ month: "2026-09", costUsd: "0.000000" }),
      }),
    ]);
    expect(only[0].latest.summary).toMatchObject({ verdict: "no-data", costPerFinishedUsd: null, successRate: null });
    agents.remove(tenantId, writer);
    expect((await call("GET", `/console/${tenantId}/outcomes`)).json().noOutcomeData).toEqual([]);

    const member = await signup("member@acme.test", "Personal");
    accounts.addMember(tenantId, member.userId, "member");
    expect((await call("PUT", url, { minutes: 10, hourlyUsd: "30" }, member.cookie)).statusCode).toBe(403);
    expect((await call("PUT", `${counts}/2026-09`, { finished: 1 }, member.cookie)).statusCode).toBe(403);
    const other = await signup("other@other.test", "Other");
    expect((await call("PUT", url, { minutes: 10, hourlyUsd: "30" }, other.cookie)).statusCode).toBe(404);
    const actions = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'agent.%' ORDER BY rowid").all();
    expect(actions.map((a) => (a as { action: string }).action)).toEqual([
      "agent.person-cost",
      "agent.person-cost",
      "agent.job-count",
    ]);
  });
});
