import { ZERO_USAGE } from "@costgrid/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentsRepository,
  CostGridRepository,
  type Db,
  openDatabase,
  Predictions,
  RoutingRepository,
  TrialsRepository,
} from "../src/index.js";

const T = "t1";
const NOW = Date.UTC(2026, 10, 7);
const DAY = 86_400_000;

describe("per-request routing and self-checks", () => {
  let db: Db;
  let repository: CostGridRepository;
  let routing: RoutingRepository;
  let seq = 0;

  const call = (model: string, cost: bigint, check: "pass" | "missing-field", at: number, kind = "summarise") => {
    seq += 1;
    repository.recordCall({
      id: `c${seq}`, tenantId: T, agentId: "support-bot", department: "Ops", provider: "anthropic", model,
      startedAt: at, durationMs: 10, streamed: false, usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 10 },
      cost: { input: cost, output: 0n, cacheWrite: 0n, cacheRead: 0n, total: cost }, priced: true,
      outcome: "ok", runId: `r${seq}`, answerCheck: check, taskKind: kind as "summarise", taskSize: "s",
    });
  };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', 0)").run(T);
    repository = new CostGridRepository(db);
    routing = new RoutingRepository(db);
    new AgentsRepository(db).create(T, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    seq = 0;
  });

  it("chooses per kind only from the agent's own measured evidence, never a prior", () => {
    routing.setSettings(T, "support-bot", { perRequest: true });
    // Sonnet is used most; Haiku has 40 judged summaries, all up to standard and far cheaper.
    for (let i = 0; i < 60; i += 1) call("claude-sonnet-4-6", 1_000n, "pass", NOW - DAY + i);
    for (let i = 0; i < 40; i += 1) call("claude-haiku-4-5", 100n, "pass", NOW - DAY + 100 + i);
    // Only 5 judged "answer" jobs on Haiku: not enough to route that kind.
    for (let i = 0; i < 5; i += 1) call("claude-haiku-4-5", 100n, "pass", NOW - DAY + 200 + i, "answer");
    expect(routing.buildAll(NOW)).toBe(1);
    const { choices } = routing.forProxy();
    expect(choices.get(`${T}|support-bot|summarise`)).toMatchObject({ model: "claude-haiku-4-5", evidenceJobs: 40 });
    expect(choices.get(`${T}|support-bot|answer`)).toBeUndefined();
    // The model it uses now is listed as not chosen, with why.
    expect(choices.get(`${T}|support-bot|summarise`)!.rejected).toContainEqual({ model: "claude-sonnet-4-6", why: "dearer per finished job" });

    routing.setSettings(T, "support-bot", { perRequest: false });
    expect(routing.forProxy().choices.size).toBe(0);
  });

  it("checks last week's predictions against the week that followed, and trusts itself less when wrong", () => {
    // Before: Sonnet's answers mostly pass, so it is predicted to be good.
    for (let i = 0; i < 30; i += 1) call("claude-sonnet-4-6", 1_000n, "pass", NOW - 3 * DAY + i);
    expect(routing.snapshot(T, NOW)).toBe(1);
    // The week after: almost every answer fails its check.
    for (let i = 0; i < 20; i += 1) call("claude-sonnet-4-6", 1_000n, "missing-field", NOW + DAY + i);
    expect(routing.check(T, NOW + 3 * DAY)).toEqual({ checked: 0, outside: 0 });
    expect(routing.check(T, NOW + 8 * DAY)).toEqual({ checked: 1, outside: 1 });
    const predictions = new Predictions(db);
    expect(predictions.trust(T, "support-bot")).toBe(0);
    const before = predictions.forAgent(T, "support-bot", { now: NOW + 8 * DAY, kind: "summarise" });
    expect(before.trust).toBe(0);
    expect(before.ranked.every((r) => r.confidence === 0)).toBe(true);
  });

  it("stops counting a grader the owner disagrees with", () => {
    const trials = new TrialsRepository(db);
    for (let i = 0; i < 10; i += 1) {
      trials.recordGrade(T, { trialId: "tr", callId: `g${i}`, runId: `r${i}`, verdict: "candidate", graderModel: "g" });
      trials.setOwnerVerdict(T, `g${i}`, i < 5 ? "candidate" : "baseline");
    }
    expect(trials.graderAgreement(T)).toEqual({ checked: 10, agreed: 5, rate: 0.5, trusted: false });
  });
});
