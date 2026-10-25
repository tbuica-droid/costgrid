import { priceUsage, usd, ZERO_USAGE } from "@costgrid/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentsRepository,
  CostGridRepository,
  type Db,
  openDatabase,
  OutcomeSettingsRepository,
  RunOutcomes,
  SourcesRepository,
} from "../src/index.js";

/**
 * From proxied calls to "did the jobs get done", per agent. The detector's
 * rules are tested in core; this checks the plumbing: runs summarised from
 * calls, sub-agents folded in, hand-off tools found, reports attached, and
 * each agent measured under its own preset.
 */

const T = "t1";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 9);
const RANGE = { from: T0 - DAY, to: T0 + 30 * DAY };
const ASOF = T0 + 30 * DAY;

describe("RunOutcomes", () => {
  let db: Db;
  let repository: CostGridRepository;
  let agents: AgentsRepository;
  let seq = 0;

  const call = (o: {
    agent: string;
    at: number;
    run?: string;
    parent?: string;
    task?: string;
    source?: "header" | "fingerprint";
    stop?: string;
    outcome?: "ok" | "error" | "blocked";
    tools?: string[];
    turns?: number;
  }) => {
    const usage = { ...ZERO_USAGE, inputTokens: 100_000 };
    const priced = priceUsage("claude-haiku-4-5", usage);
    const id = `c${(seq += 1)}`;
    repository.recordCall({
      id, tenantId: T, agentId: o.agent, department: "Ops", provider: "anthropic", model: "claude-haiku-4-5",
      startedAt: o.at, durationMs: 1000, streamed: false, usage, cost: priced.cost, priced: priced.priced,
      outcome: o.outcome ?? "ok", stopReason: o.stop ?? "end_turn",
      runId: o.run ?? id, runDeclared: o.run !== undefined, ...(o.parent ? { parentRunId: o.parent } : {}), runDepth: o.parent ? 1 : 0,
      ...(o.task ? { taskKey: o.task, taskSource: o.source ?? "header" } : {}),
      ...(o.turns !== undefined ? { turns: o.turns } : {}),
    });
    if (o.tools) repository.recordTools({ tenantId: T, callId: id, runId: o.run ?? id, agentId: o.agent, invoked: o.tools, granted: o.tools, at: o.at });
    return priced.cost.total;
  };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', 0)").run(T);
    repository = new CostGridRepository(db);
    agents = new AgentsRepository(db);
    seq = 0;
  });

  it("decides each agent's jobs under its preset, from calls, tools and reports", () => {
    agents.create(T, { name: "Support bot", purposeId: "support", purposeVersion: "2" });
    // Finished: identified by the developer's id, ended normally.
    call({ agent: "support-bot", at: T0, run: "a1", task: "ticket-1" });
    // Asked again within a day: one job, the first try did not finish; a sub-agent run folds in.
    call({ agent: "support-bot", at: T0 + HOUR, run: "b1", task: "abc", source: "fingerprint" });
    call({ agent: "support-bot", at: T0 + HOUR + MIN, run: "b1-sub", parent: "b1" });
    call({ agent: "support-bot", at: T0 + 5 * HOUR, run: "b2", task: "abc", source: "fingerprint" });
    // Handed to a person.
    call({ agent: "support-bot", at: T0 + 6 * HOUR, run: "c1", task: "ticket-3", tools: ["handoff_to_human"] });
    // Cut off, with no job identity: still a failure.
    call({ agent: "support-bot", at: T0 + 7 * HOUR, stop: "max_tokens" });
    // Ended normally, no identity: can't tell.
    call({ agent: "support-bot", at: T0 + 8 * HOUR });
    // Reported by the owner's software, despite the error.
    call({ agent: "support-bot", at: T0 + 9 * HOUR, run: "e1", outcome: "error" });
    repository.recordOutcome({ tenantId: T, runId: "e1", succeeded: true, label: "resolved", at: T0 + 9 * HOUR + 5 * MIN });

    const report = new RunOutcomes(db).forTenant(T, RANGE, ASOF);
    expect(report.agents).toHaveLength(1);
    const a = report.agents[0]!;
    expect(a).toMatchObject({ agentId: "support-bot", name: "Support bot", purposeSet: true, needsUpgrade: false });
    expect(a.preset).toMatchObject({ id: "support", version: "2" });
    expect(a.escalationTools).toEqual(["handoff_to_human"]);
    expect(a.result!.counts).toMatchObject({ success: 3, failure: 2, unknown: 1, resolved: 6 });
    expect(a.result!.evidenceTiers).toMatchObject({ B: 1, C: 5 });

    const retried = a.tasks.find((t) => t.task.runs.some((r) => r.runId === "b1"))!;
    expect(retried.task.runs.map((r) => r.runId)).toEqual(["b1", "b2"]);
    expect(retried.signals).toEqual(["asked-again", "finished"]);
    // The sub-agent's cost is part of the run that started it.
    expect(a.totalCost).toBe(a.tasks.reduce((s, t) => s + t.task.runs.reduce((x, r) => x + r.cost, 0n), 0n));
    expect(retried.task.runs[0]!.cost).toBeGreaterThan(retried.task.runs[1]!.cost);
  });

  it("asks an agent on a version 1 preset to turn detection on, and lists agents with no proxied runs", () => {
    agents.create(T, { name: "Old bot", purposeId: "support", purposeVersion: "1" });
    call({ agent: "old-bot", at: T0, run: "x1", task: "t" });
    const writer = agents.create(T, { name: "Writer", purposeId: "content", purposeVersion: "2" })!;
    new SourcesRepository(db).upsertSources(T, [{ provider: "openai", kind: "project", id: "proj_w" }], { first: "2026-10-01", last: "2026-10-01" });
    agents.assign(T, { provider: "openai", kind: "project", id: "proj_w" }, { agentId: writer, shared: false, by: "owner" });

    const report = new RunOutcomes(db).forTenant(T, RANGE, ASOF);
    expect(report.agents).toEqual([expect.objectContaining({ agentId: "old-bot", needsUpgrade: true, tasks: [] })]);
    expect(report.agents[0]!.result).toBeUndefined();
    expect(report.noOutcomeData).toEqual([{ id: writer, name: "Writer" }]);
  });

  it("measures an agent with no purpose as 'other', and says so", () => {
    call({ agent: "classifier", at: T0, run: "k1", task: "t1" });
    const a = new RunOutcomes(db).forTenant(T, RANGE, ASOF).agents[0]!;
    expect(a).toMatchObject({ agentId: "classifier", purposeSet: false, needsUpgrade: false });
    expect(a.preset).toMatchObject({ id: "other", version: "2" });
  });

  it("forgets every saved code when matching is turned off, and keeps the developer's ids", () => {
    call({ agent: "bot", at: T0, task: "abc", source: "fingerprint" });
    call({ agent: "bot", at: T0 + MIN, task: "ticket-9", source: "header" });
    const settings = new OutcomeSettingsRepository(db);
    expect(settings.fingerprintEnabled(T)).toBe(true);
    expect(settings.setFingerprint(T, false)).toBe(1);
    expect(settings.fingerprintEnabled(T)).toBe(false);
    expect(db.prepare("SELECT task_key, task_source FROM calls ORDER BY started_at").all()).toEqual([
      { task_key: null, task_source: null },
      { task_key: "ticket-9", task_source: "header" },
    ]);
    expect(settings.setFingerprint(T, true)).toBe(0);
    expect(settings.fingerprintEnabled(T)).toBe(true);
  });

  it("keeps each organisation's runs to itself", () => {
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t2', 'Other', 0)").run();
    call({ agent: "bot", at: T0, task: "x" });
    expect(new RunOutcomes(db).forTenant("t2", RANGE, ASOF)).toEqual({ agents: [], noOutcomeData: [], longestWindowMs: 0 });
    expect(usd("0")).toBe(0n);
  });
});
