import { formatUsdPerOutcome, priceUsage, ZERO_USAGE, type AnswerCheck } from "@costgrid/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentsRepository,
  CostGridRepository,
  type Db,
  openDatabase,
  QualityRepository,
  RunOutcomes,
  statementJobs,
} from "../src/index.js";

/**
 * Cost per good job, from calls to the statement: a finished job counts as
 * good unless a check on its last answer failed, a person edited or rejected
 * it, or a reported score fell under the agent's bar.
 */

const T = "t1";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 9);
const RANGE = { from: T0 - DAY, to: T0 + 30 * DAY };
const ASOF = T0 + 30 * DAY;

describe("cost per good job", () => {
  let db: Db;
  let repository: CostGridRepository;
  let quality: QualityRepository;
  let seq = 0;

  /** One job of one call, labelled by the developer so it is recognised; $0.10 each. */
  const job = (o: { check?: AnswerCheck; score?: number; signal?: string; stop?: string }) => {
    const id = `c${(seq += 1)}`;
    const usage = { ...ZERO_USAGE, inputTokens: 100_000 };
    const priced = priceUsage("claude-haiku-4-5", usage);
    repository.recordCall({
      id, tenantId: T, agentId: "support-bot", department: "Ops", provider: "anthropic", model: "claude-haiku-4-5",
      startedAt: T0 + seq * 1000, durationMs: 100, streamed: false, usage, cost: priced.cost, priced: true,
      outcome: "ok", stopReason: o.stop ?? "end_turn", runId: `r${seq}`, runDeclared: true,
      taskKey: `ticket-${seq}`, taskSource: "header",
      ...(o.check !== undefined ? { answerCheck: o.check } : {}),
    });
    if (o.score !== undefined || o.signal !== undefined) {
      repository.recordOutcome({
        tenantId: T, runId: `r${seq}`, succeeded: true, at: T0 + seq * 1000 + 500,
        ...(o.score !== undefined ? { qualityMilli: Math.round(o.score * 1000) } : {}),
        ...(o.signal !== undefined ? { signal: o.signal } : {}),
      });
    }
  };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', 0)").run(T);
    repository = new CostGridRepository(db);
    quality = new QualityRepository(db);
    new AgentsRepository(db).create(T, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    seq = 0;
  });

  it("counts finished jobs below the bar out of cost per good job", () => {
    job({ check: "pass" }); // good, judged
    job({ check: "missing-field" }); // finished, below
    job({ score: 0.9 }); // good, judged
    job({ score: 0.3 }); // finished, below the default bar of 0.5
    job({ signal: "rejected" }); // finished, below
    job({}); // finished, no evidence: counts as good

    const agent = new RunOutcomes(db).forTenant(T, RANGE, ASOF).agents[0]!;
    expect(agent.result!.counts).toMatchObject({ success: 6, good: 3, qualityKnown: 5 });
    // Six jobs at $0.10 is $0.60 of spend: $0.10 per finished job, $0.20 per good one.
    expect(formatUsdPerOutcome(agent.result!.lcso.lcso1.reported ? agent.result!.lcso.lcso1.value : { num: 0n, den: 1n }, 2)).toBe("0.10");
    expect(agent.result!.lcso.good).toMatchObject({ reported: true });
    expect(formatUsdPerOutcome((agent.result!.lcso.good as { value: { num: bigint; den: bigint } }).value, 2)).toBe("0.20");
    expect(agent.quality).toMatchObject({ checks: { pass: 1, "missing-field": 1 }, scored: 2, scoreP10: 300, scoreP90: 900 });
  });

  it("uses the agent's own bar when the owner sets one", () => {
    expect(quality.set(T, "support-bot", { format: "any" }, 250)).toBe(true);
    job({ score: 0.3 });
    const agent = new RunOutcomes(db).forTenant(T, RANGE, ASOF).agents[0]!;
    expect(agent.result!.counts).toMatchObject({ good: 1, qualityKnown: 1 });
  });

  it("carries cost per good job onto the statement", () => {
    job({ check: "pass" });
    job({ check: "not-json" });
    const jobs = statementJobs(new RunOutcomes(db), T, "2026-10", { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 10, 1) }, ASOF);
    expect(jobs.methodologyVersion).toBe("0.2");
    expect(jobs.rows[0]).toMatchObject({ finished: 2, good: 1, qualityKnown: 2 });
    expect(jobs.rows[0]!.costPerGood).toBeDefined();
  });

  it("keeps answer specs and logs decisions, newest first", () => {
    quality.set(T, "support-bot", { format: "json", requiredFields: ["category"] }, null);
    expect(quality.forAgent(T, "support-bot")).toMatchObject({ spec: { format: "json", requiredFields: ["category"] }, barMilli: 500, barSet: false });
    expect(quality.forAgent(T, "nobody").spec).toEqual({ format: "any" });
    for (const [at, kind] of [[1, "route"], [2, "adjust"]] as const) {
      quality.recordDecision({
        tenantId: T, callId: `c${at}`, agentId: "support-bot", decidedAt: at, kind,
        requestedModel: "a", chosenModel: "b", applied: true, reason: "because",
        rejected: [{ model: "a", why: "dearer" }],
      });
    }
    const decisions = quality.recentDecisions(T);
    expect(decisions.map((d) => d.kind)).toEqual(["adjust", "route"]);
    expect(decisions[1]).toMatchObject({ rejected: [{ model: "a", why: "dearer" }], predictedCost: undefined });
  });
});
