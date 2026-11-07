import { ZERO_USAGE } from "@costgrid/core";
import {
  AgentsRepository,
  Analytics,
  AuditLog,
  CostGridRepository,
  type Db,
  ImportsRepository,
  openDatabase,
  type Trial,
  TrialsRepository,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { readVerdict } from "../src/grading.js";
import { createServer, spotChecksOf } from "../src/server.js";
import { applyTrial, reviewTrials } from "../src/trial-review.js";

const T = "t1";
const NOW = Date.UTC(2026, 10, 7);

describe("switching and switching back", () => {
  let db: Db;
  let repository: CostGridRepository;
  let trials: TrialsRepository;
  let audit: AuditLog;
  let seq = 0;

  const call = (o: { trial?: Trial; arm?: "candidate" | "baseline"; cost: bigint; check?: "pass" | "missing-field"; at: number; routed?: boolean }) => {
    seq += 1;
    repository.recordCall({
      id: `c${seq}`, tenantId: T, agentId: "support-bot", department: "Ops", provider: "anthropic",
      model: o.arm === "candidate" || o.routed ? "claude-haiku-4-5" : "claude-sonnet-4-6",
      startedAt: o.at, durationMs: 10, streamed: false, usage: ZERO_USAGE,
      cost: { input: o.cost, output: 0n, cacheWrite: 0n, cacheRead: 0n, total: o.cost }, priced: true,
      outcome: "ok", runId: `r${seq}`, runDeclared: true, ...(o.check ? { answerCheck: o.check } : {}),
      ...(o.trial && o.arm ? { trialId: o.trial.id, trialArm: o.arm } : {}),
      ...(o.routed ? { requestedModel: "claude-sonnet-4-6", routed: true } : {}),
    });
  };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', 0)").run(T);
    repository = new CostGridRepository(db);
    trials = new TrialsRepository(db);
    audit = new AuditLog(db);
    new AgentsRepository(db).create(T, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    seq = 0;
  });

  const passedTrial = () => {
    const t = trials.start(T, { agentId: "support-bot", baselineModel: "claude-sonnet-4-6", candidateModel: "claude-haiku-4-5", minJobs: 20 }, NOW) as Trial;
    for (let i = 0; i < 20; i += 1) {
      call({ trial: t, arm: "candidate", cost: 10n, check: "pass", at: NOW + i });
      call({ trial: t, arm: "baseline", cost: 100n, check: "pass", at: NOW + i });
    }
    return t;
  };

  it("waits for the owner on a first passed trial, then switches on its own once allowed", () => {
    const first = passedTrial();
    expect(reviewTrials({ db, audit }, NOW + 1000)).toEqual([`${first.id}:passed`]);
    expect(repository.listPolicies(T)).toEqual([]);
    applyTrial({ db, audit }, T, trials.get(T, first.id)!, { kind: "user", id: "u", label: "owner@acme.test" }, NOW + 2000);
    const rule = repository.listPolicies(T)[0]!;
    expect(rule).toMatchObject({ scope: { kind: "agent", agentId: "support-bot" }, rule: { kind: "route", toModel: "claude-haiku-4-5" }, action: "warn" });

    trials.setAgentSettings(T, "support-bot", { switching: "auto" });
    repository.setPolicyEnabled(rule.id, false);
    const second = passedTrial();
    expect(reviewTrials({ db, audit }, NOW + 3000)).toEqual([`${second.id}:passed`, `${second.id}:applied`]);
    const actions = (db.prepare("SELECT action, actor_label AS by FROM audit_log ORDER BY seq").all() as { action: string; by: string }[]);
    expect(actions.filter((a) => a.action === "switch.applied").map((a) => a.by)).toEqual(["owner@acme.test", "CostGrid trials"]);
  });

  it("switches back when a good job costs more after the switch", () => {
    const t = passedTrial();
    reviewTrials({ db, audit }, NOW + 1000);
    applyTrial({ db, audit }, T, trials.get(T, t.id)!, { kind: "user", id: "u", label: "owner" }, NOW + 2000);
    // Since the switch: 30 jobs, each costing more than the old model's.
    for (let i = 0; i < 30; i += 1) call({ cost: 500n, check: "pass", at: NOW + 3000 + i, routed: true });
    expect(reviewTrials({ db, audit }, NOW + 10_000)).toEqual([`${t.id}:reverted`]);
    expect(repository.listPolicies(T)[0]!.enabled).toBe(false);
    expect(trials.get(T, t.id)!.status).toBe("reverted");
  });
});

const CONFIG: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: { anthropic: "sk-ant-test" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  logLevel: "silent",
};

describe("trials through the proxy", () => {
  let db: Db;
  let trials: TrialsRepository;
  let app: FastifyInstance;
  let apiKey: string;
  let sent: { model: string; prompt: string }[];

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    const repository = new CostGridRepository(db);
    repository.createTenant("Acme", T);
    apiKey = repository.createApiKey(T, "svc").plaintext;
    new AgentsRepository(db).create(T, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    trials = new TrialsRepository(db);
    sent = [];
    app = createServer({
      config: CONFIG,
      db,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
        const prompt = String(body.messages.at(-1)?.content ?? "");
        sent.push({ model: body.model, prompt });
        // The grader always prefers answer A; the shadow call answers as its model.
        const text = prompt.includes("grading two answers") ? "A" : `answer from ${body.model}`;
        return Response.json({ model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
      }) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const send = (task: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot", "x-costgrid-task": task, ...headers },
      payload: { model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "Where is my order?" }] },
    });
  const arms = () => db.prepare("SELECT model, trial_arm AS arm, purpose FROM calls ORDER BY rowid").all();

  it("sends the trial's share of jobs to the candidate and tags both arms", async () => {
    const t = trials.start(T, { agentId: "support-bot", baselineModel: "claude-sonnet-4-6", candidateModel: "claude-haiku-4-5", shareMilli: 1000 }) as Trial;
    await send("job-1");
    trials.setStatus(T, t.id, "stopped", "test");
    trials.start(T, { agentId: "support-bot", baselineModel: "claude-sonnet-4-6", candidateModel: "claude-haiku-4-5", shareMilli: 0 });
    await send("job-2");
    expect(arms()).toEqual([
      { model: "claude-haiku-4-5", arm: "candidate", purpose: "work" },
      { model: "claude-sonnet-4-6", arm: "baseline", purpose: "work" },
    ]);
  });

  it("never tests a request marked critical", async () => {
    trials.start(T, { agentId: "support-bot", baselineModel: "claude-sonnet-4-6", candidateModel: "claude-haiku-4-5", shareMilli: 1000 });
    await send("job-1", { "x-costgrid-critical": "true" });
    expect(arms()).toEqual([{ model: "claude-sonnet-4-6", arm: null, purpose: "work" }]);
  });

  it("holds no answer in memory while spot checks are off", async () => {
    trials.setGrading(T, true, 1000);
    trials.start(T, { agentId: "support-bot", baselineModel: "claude-sonnet-4-6", candidateModel: "claude-haiku-4-5", shareMilli: 1000 });
    await send("job-1");
    await new Promise((r) => setTimeout(r, 30));
    const callId = (db.prepare("SELECT call_id AS id FROM grades").get() as { id: string }).id;
    expect(spotChecksOf(app)!.get(T, callId)).toBeUndefined();
  });

  it("grades a sampled job side by side, keeps only the verdict, and counts the cost", async () => {
    trials.setGrading(T, true, 1000);
    trials.setSpotChecks(T, true);
    const t = trials.start(T, { agentId: "support-bot", baselineModel: "claude-sonnet-4-6", candidateModel: "claude-haiku-4-5", shareMilli: 1000 }) as Trial;
    await send("job-1");
    await new Promise((r) => setTimeout(r, 30));
    // The job, the same request on the other model, and the grader.
    expect(arms()).toEqual([
      { model: "claude-haiku-4-5", arm: "candidate", purpose: "work" },
      { model: "claude-sonnet-4-6", arm: null, purpose: "grading" },
      { model: expect.stringMatching(/^claude-/), arm: null, purpose: "grading" },
    ]);
    const grade = db.prepare("SELECT trial_id AS trial, verdict FROM grades").get() as { trial: string; verdict: string };
    expect(grade.trial).toBe(t.id);
    expect(["candidate", "baseline"]).toContain(grade.verdict);
    // The answers are in memory for spot checks, and nowhere in the database.
    const callId = (db.prepare("SELECT call_id AS id FROM grades").get() as { id: string }).id;
    expect(spotChecksOf(app)!.get(T, callId)).toMatchObject({ candidate: "answer from claude-haiku-4-5", baseline: "answer from claude-sonnet-4-6" });
    const everything = JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).flatMap((x) => db.prepare(`SELECT * FROM "${x.name}"`).all()));
    expect(everything).not.toContain("answer from");
  });

  it("reads the grader's one-word reply, and nothing else", () => {
    expect(readVerdict(" A.")).toBe("A");
    expect(readVerdict("TIE")).toBe("TIE");
    expect(readVerdict("b")).toBe("B");
    expect(readVerdict("Answer A is better")).toBeUndefined();
  });
});
