import { ZERO_USAGE } from "@costgrid/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentsRepository,
  CostGridRepository,
  type Db,
  inCandidateArm,
  openDatabase,
  type Trial,
  TrialsRepository,
} from "../src/index.js";

const T = "t1";
const NOW = Date.UTC(2026, 10, 7);

describe("trials", () => {
  let db: Db;
  let repository: CostGridRepository;
  let trials: TrialsRepository;
  let seq = 0;

  /** One job: one call on one arm, costing `cost` nanodollars. */
  const job = (trial: Trial | undefined, arm: "candidate" | "baseline" | undefined, o: { cost: bigint; check?: "pass" | "missing-field"; error?: boolean; at?: number; routed?: boolean }) => {
    seq += 1;
    repository.recordCall({
      id: `c${seq}`, tenantId: T, agentId: "support-bot", department: "Ops", provider: "anthropic",
      model: arm === "candidate" || o.routed ? "claude-haiku-4-5" : "claude-sonnet-4-6",
      startedAt: o.at ?? NOW + seq, durationMs: 10, streamed: false,
      usage: { ...ZERO_USAGE, inputTokens: 100 },
      cost: { input: o.cost, output: 0n, cacheWrite: 0n, cacheRead: 0n, total: o.cost }, priced: true,
      outcome: o.error ? "error" : "ok", runId: `r${seq}`, runDeclared: true,
      ...(o.check ? { answerCheck: o.check } : {}),
      ...(trial && arm ? { trialId: trial.id, trialArm: arm } : {}),
      ...(o.routed ? { requestedModel: "claude-sonnet-4-6", routed: true } : {}),
    });
  };

  const start = (minJobs = 20) => {
    const t = trials.start(T, { agentId: "support-bot", baselineModel: "claude-sonnet-4-6", candidateModel: "claude-haiku-4-5", minJobs }, NOW);
    if (typeof t === "string") throw new Error(t);
    return t;
  };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', 0)").run(T);
    repository = new CostGridRepository(db);
    trials = new TrialsRepository(db);
    new AgentsRepository(db).create(T, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    seq = 0;
  });

  it("puts a job in an arm by a stable hash, close to the share", () => {
    expect(inCandidateArm("trial_x", "job-1", 50)).toBe(inCandidateArm("trial_x", "job-1", 50));
    const hits = Array.from({ length: 10_000 }, (_, i) => inCandidateArm("trial_x", `job-${i}`, 50)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(400);
    expect(hits).toBeLessThan(600);
  });

  it("refuses a trial on critical work, or a second at once", () => {
    trials.setAgentSettings(T, "support-bot", { critical: true });
    expect(trials.start(T, { agentId: "support-bot", baselineModel: "a", candidateModel: "b" })).toContain("critical");
    trials.setAgentSettings(T, "support-bot", { critical: false });
    start();
    expect(trials.start(T, { agentId: "support-bot", baselineModel: "a", candidateModel: "b" })).toContain("already");
  });

  it("passes a candidate that is as good and cheaper per good job", () => {
    const t = start();
    for (let i = 0; i < 20; i += 1) {
      job(t, "candidate", { cost: 10n, check: "pass" });
      job(t, "baseline", { cost: 100n, check: "pass" });
    }
    const j = trials.judge(T, t);
    expect(j.status).toBe("passed");
    expect(j.why).toContain("90% cheaper per good job");
    expect(j.candidate).toMatchObject({ jobs: 20, good: 20, costPerGoodJob: 10n, qualityShare: 1 });
  });

  it("fails a cheaper candidate whose answers fall short", () => {
    const t = start();
    for (let i = 0; i < 20; i += 1) {
      job(t, "candidate", { cost: 10n, check: i < 15 ? "pass" : "missing-field" });
      job(t, "baseline", { cost: 100n, check: "pass" });
    }
    expect(trials.judge(T, t)).toMatchObject({ status: "failed" });
    expect(trials.judge(T, t).why).toContain("lower quality");
  });

  it("waits for enough jobs, but fails at once on a burst of errors", () => {
    const t = start(100);
    for (let i = 0; i < 5; i += 1) job(t, "candidate", { cost: 0n, error: true });
    for (let i = 0; i < 20; i += 1) job(t, "baseline", { cost: 100n });
    expect(trials.judge(T, t).why).toContain("5 of the candidate's calls failed");
    const u = trials.start(T, { agentId: "other", baselineModel: "a", candidateModel: "b" });
    expect(typeof u === "string" ? u : trials.judge(T, u).status).toBe("running");
  });
});
