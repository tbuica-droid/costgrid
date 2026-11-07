import { deriveMasterKey } from "@costgrid/core";
import { AccountsRepository, AgentsRepository, Analytics, CostGridRepository, ImportsRepository, openDatabase, type Trial, TrialsRepository } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer, spotChecksOf } from "../src/server.js";

const MASTER_SECRET = "test-master-key-long-enough-to-be-accepted-0123456789";
const HOSTED: GatewayConfig = {
  port: 0, host: "127.0.0.1", databasePath: ":memory:", providerKeys: {}, providerBaseUrls: {}, upstreamTimeoutMs: 5_000,
  injectUsageRequest: true, allowAnonymous: false, hosted: true, masterKeySecret: MASTER_SECRET, secureCookies: false, logLevel: "silent",
};

describe("trials on the console", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;
  let trials: TrialsRepository;
  const call = (method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
    app.inject({ method, url: `/console/${tenantId}${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });

  beforeEach(async () => {
    db = openDatabase({ path: ":memory:" });
    app = createServer({ config: HOSTED, db, repository: new CostGridRepository(db), analytics: new Analytics(db), accounts: new AccountsRepository(db, deriveMasterKey(MASTER_SECRET)), imports: new ImportsRepository(db) });
    const res = await app.inject({ method: "POST", url: "/console/signup", payload: { email: "o@acme.test", name: "O", password: "a-sufficiently-long-password", organisation: "Acme" } });
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    tenantId = res.json().tenantId as string;
    new AgentsRepository(db).create(tenantId, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    trials = new TrialsRepository(db);
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("lets an agent switch on its own only after an approved trial (D14)", async () => {
    expect((await call("PUT", "/agents/support-bot/trial-settings", { switching: "auto" })).statusCode).toBe(400);
    const t = trials.start(tenantId, { agentId: "support-bot", baselineModel: "a", candidateModel: "b" }) as Trial;
    expect((await call("POST", `/trials/${t.id}/approve`)).statusCode).toBe(400);
    trials.setStatus(tenantId, t.id, "passed", "as good and cheaper");
    const approved = await call("POST", `/trials/${t.id}/approve`);
    expect(approved.json()).toMatchObject({ status: "applied" });
    expect((await call("PUT", "/agents/support-bot/trial-settings", { switching: "auto" })).json()).toEqual({ critical: false, switching: "auto" });
  });

  it("stops a running trial when the work is marked critical", async () => {
    const t = trials.start(tenantId, { agentId: "support-bot", baselineModel: "a", candidateModel: "b" }) as Trial;
    await call("PUT", "/agents/support-bot/trial-settings", { critical: true });
    expect(trials.get(tenantId, t.id)!.status).toBe("stopped");
  });

  it("samples only 1% to 2% for grading, and keeps spot checks blind", async () => {
    expect((await call("PUT", "/grading", { enabled: true, sharePct: 5 })).statusCode).toBe(400);
    expect((await call("PUT", "/grading", { enabled: true, sharePct: 1.5 })).json()).toEqual({ enabled: true, shareMilli: 15 });
    trials.recordGrade(tenantId, { trialId: "tr", callId: "c1", runId: "r1", verdict: "candidate", graderModel: "g" });
    spotChecksOf(app)!.put(tenantId, "c1", { trialId: "tr", runId: "r1", task: "q", candidate: "cand", baseline: "base", verdict: "candidate", at: Date.now() });
    const list = (await call("GET", "/trials")).json();
    expect(list.spotChecks[0]).not.toHaveProperty("verdict");
    const pair = (await call("GET", "/spot-checks/c1")).json();
    expect([pair.a, pair.b].sort()).toEqual(["base", "cand"]);
    const which = pair.a === "cand" ? "a" : "b";
    await call("PUT", "/spot-checks/c1", { verdict: which });
    expect(db.prepare("SELECT owner_verdict AS v FROM grades").get()).toEqual({ v: "candidate" });
    expect((await call("GET", "/spot-checks/c1")).statusCode).toBe(404);
  });

  it("chooses per request only after an approved trial, and ranks models for a pasted sample", async () => {
    expect((await call("PUT", "/agents/support-bot/routing", { perRequest: true })).statusCode).toBe(400);
    expect((await call("PUT", "/agents/support-bot/routing", { stepUpModel: "no-such-model" })).statusCode).toBe(400);
    expect((await call("PUT", "/agents/support-bot/routing", { stepUpModel: "claude-haiku-4-5" })).json()).toEqual({ perRequest: false, stepUpModel: "claude-haiku-4-5" });
    const t = trials.start(tenantId, { agentId: "support-bot", baselineModel: "a", candidateModel: "b" }) as Trial;
    trials.setStatus(tenantId, t.id, "passed", "ok");
    await call("POST", `/trials/${t.id}/approve`);
    expect((await call("PUT", "/agents/support-bot/routing", { perRequest: true })).json()).toMatchObject({ perRequest: true });

    const ranked = (await call("POST", "/which-model", { agentId: "support-bot", sample: "Please summarise this note" })).json();
    expect(ranked).toMatchObject({ agent: "support-bot", kind: "summarise" });
    const checks = (await call("GET", "/self-checks")).json();
    expect(checks).toMatchObject({ checks: [], grader: { checked: 0, trusted: true } });
  });
});
