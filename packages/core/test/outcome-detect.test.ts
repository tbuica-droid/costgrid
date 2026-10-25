import { describe, expect, it } from "vitest";
import {
  computeLcso,
  type DetectedTask,
  detectOutcomes,
  matchesEscalation,
  type RunSummary,
  runStatusOf,
  usd,
} from "../src/index.js";

/**
 * Deciding whether each job got done from how the agent behaved. A wrong
 * "finished" flatters an agent and a wrong "failed" condemns it, so every
 * rule and every window edge is pinned here.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 9);
const WINDOWS = { reRunWindowMs: 24 * HOUR, maturationWindowMs: 7 * DAY };
const ASOF = T0 + 30 * DAY;

let seq = 0;
function run(over: Partial<RunSummary> & { at?: number } = {}): RunSummary {
  const startedAt = over.at ?? T0;
  const { at: _at, ...rest } = over;
  seq += 1;
  return {
    runId: `r${String(seq).padStart(3, "0")}`,
    taskKey: "job-1",
    taskSource: "header",
    startedAt,
    endedAt: startedAt + MIN,
    cost: usd("0.10"),
    finalStatus: "ok",
    escalated: false,
    ...rest,
  };
}

const only = (runs: RunSummary[], asOf = ASOF): DetectedTask => {
  const { tasks } = detectOutcomes(runs, WINDOWS, asOf);
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
};

describe("how a run ended", () => {
  it("reads every provider's stop reasons", () => {
    expect(runStatusOf("ok", 200, "end_turn")).toBe("ok");
    expect(runStatusOf("ok", 200, "tool_use")).toBe("ok");
    expect(runStatusOf("ok", 200, "stop")).toBe("ok");
    expect(runStatusOf("ok", 200, null)).toBe("ok");
    expect(runStatusOf("ok", 200, "max_tokens")).toBe("truncated");
    expect(runStatusOf("ok", 200, "length")).toBe("truncated");
    expect(runStatusOf("ok", 200, "incomplete")).toBe("truncated");
    expect(runStatusOf("ok", 200, "refusal")).toBe("refused");
    expect(runStatusOf("ok", 200, "content_filter")).toBe("refused");
    expect(runStatusOf("ok", 200, "failed")).toBe("error");
    expect(runStatusOf("error", 502, null)).toBe("error");
    expect(runStatusOf("blocked", 429, null)).toBe("blocked");
    // A tool the gateway refused after the model asked for it.
    expect(runStatusOf("ok", 403, "tool_use")).toBe("blocked");
  });
});

describe("hand-off tools", () => {
  it("recognises a person taking over, however the tool is named", () => {
    for (const name of ["handoff_to_human", "escalateTicket", "transfer-to-agent", "hand_off", "liveAgent", "contact_operator", "TransferToSupport", "request_human_review"]) {
      expect(matchesEscalation(name), name).toBe(true);
    }
    for (const name of ["transfer_funds", "search_orders", "send_email", "humanize_text_x"]) {
      expect(matchesEscalation(name), name).toBe(false);
    }
  });
});

describe("detectOutcomes", () => {
  it("calls a recognised job that ended normally finished, as inferred evidence", () => {
    const t = only([run()]);
    expect(t.task).toMatchObject({ state: "SUCCESS", evidenceTier: "C", resolvedAt: T0 + MIN });
    expect(t.signals).toEqual(["finished"]);
  });

  it("counts a job asked again within the re-run window as one job, the earlier try not finished", () => {
    const first = run();
    const again = run({ at: T0 + MIN + 24 * HOUR }); // exactly on the edge
    const t = only([first, again]);
    expect(t.task.runs.map((r) => r.runId)).toEqual([first.runId, again.runId]);
    expect(t.task.finalRunId).toBe(again.runId);
    expect(t.signals).toEqual(["asked-again", "finished"]);

    // One millisecond past the window, it is a new job, and the first is reversed.
    const late = run({ at: T0 + MIN + 24 * HOUR + 1 });
    const { tasks } = detectOutcomes([first, late], WINDOWS, ASOF);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.task).toMatchObject({ state: "SUCCESS", reversedAt: late.startedAt });
    expect(tasks[0]!.signals).toContain("reversed");
  });

  it("reverses only inside the maturation window", () => {
    const first = run();
    const muchLater = run({ at: T0 + MIN + 7 * DAY + 1 });
    const { tasks } = detectOutcomes([first, muchLater], WINDOWS, ASOF);
    expect(tasks[0]!.task.reversedAt).toBeUndefined();
    // And never after the moment of computation.
    const soon = run({ at: T0 + 2 * DAY });
    expect(detectOutcomes([first, soon], WINDOWS, T0 + DAY).tasks[0]!.task.reversedAt).toBeUndefined();
  });

  it("puts a hand-off, a limit and a bad ending ahead of a normal one", () => {
    expect(only([run({ escalated: true })]).task).toMatchObject({ state: "FAILURE", evidenceTier: "C" });
    expect(only([run({ escalated: true })]).signals).toEqual(["handed-off"]);
    expect(only([run({ finalStatus: "blocked" })]).task.state).toBe("ABANDONED");
    for (const status of ["error", "truncated", "refused"] as const) {
      const t = only([run({ finalStatus: status })]);
      expect(t.task.state).toBe("FAILURE");
      expect(t.signals).toEqual([status]);
    }
    // A hand-off on an earlier try still counts, even if the last try ended normally.
    expect(only([run({ escalated: true }), run({ at: T0 + HOUR })]).task.state).toBe("FAILURE");
  });

  it("never overrides what the owner's software reported", () => {
    const reported = run({ finalStatus: "error", reported: { succeeded: true, at: T0 + 2 * MIN } });
    const t = only([reported]);
    expect(t.task).toMatchObject({ state: "SUCCESS", evidenceTier: "B", resolvedAt: T0 + 2 * MIN });
    // Asked again later: the report stands, with no reversal.
    const { tasks } = detectOutcomes([reported, run({ at: T0 + 3 * DAY })], WINDOWS, ASOF);
    expect(tasks[0]!.task).toMatchObject({ evidenceTier: "B" });
    expect(tasks[0]!.task.reversedAt).toBeUndefined();
    // The latest report wins.
    const changed = run({ reported: { succeeded: true, at: T0 + 2 * MIN } });
    const after = run({ at: T0 + HOUR, reported: { succeeded: false, at: T0 + HOUR + MIN } });
    expect(only([changed, after]).task.state).toBe("FAILURE");
  });

  it("will not call a job finished when it could not have seen a re-run", () => {
    const t = only([run({ taskKey: undefined, taskSource: "none" })]);
    expect(t.task).toMatchObject({ state: "UNKNOWN", taskId: expect.stringMatching(/^run:/) });
    expect(t.signals).toEqual(["no-identity"]);
    // But a failure is positive evidence, and still counts without identity.
    expect(only([run({ taskKey: undefined, taskSource: "none", finalStatus: "truncated" })]).task.state).toBe("FAILURE");
  });

  it("treats a conversation that carries on as one attempt, not a retry", () => {
    const turn1 = run({ taskSource: "fingerprint", taskKey: "abc", turns: 1 });
    const turn2 = run({ taskSource: "fingerprint", taskKey: "abc", turns: 3, at: T0 + 2 * MIN });
    const t = only([turn1, turn2]);
    expect(t.signals).toEqual(["finished"]);
    expect(t.task.runs).toHaveLength(2);
  });

  it("ignores a fingerprint shared by jobs running at the same time", () => {
    const a = run({ taskSource: "fingerprint", taskKey: "hi-template", at: T0, endedAt: T0 + 10 * MIN });
    const b = run({ taskSource: "fingerprint", taskKey: "hi-template", at: T0 + MIN });
    const { tasks, sharedOpenings } = detectOutcomes([a, b], WINDOWS, ASOF);
    expect(sharedOpenings).toBe(2);
    expect(tasks.map((t) => [t.task.state, t.source])).toEqual([
      ["UNKNOWN", "none"],
      ["UNKNOWN", "none"],
    ]);
    expect(tasks[0]!.signals).toEqual(["shared-opening", "no-identity"]);
  });

  it("ignores a fingerprint that keeps coming back, but always trusts the developer's id", () => {
    const template = Array.from({ length: 6 }, (_, i) =>
      run({ taskSource: "fingerprint", taskKey: "same-opening", at: T0 + i * HOUR }),
    );
    const { tasks, sharedOpenings } = detectOutcomes(template, WINDOWS, ASOF);
    expect(tasks).toHaveLength(6);
    expect(sharedOpenings).toBe(6);
    expect(tasks.every((t) => t.task.state === "UNKNOWN")).toBe(true);

    const header = Array.from({ length: 6 }, (_, i) => run({ taskKey: "ticket-9", at: T0 + i * HOUR }));
    const one = only(header);
    expect(one.task.runs).toHaveLength(6);
    expect(one.task.state).toBe("SUCCESS");
  });

  it("feeds the LCSO engine: retries are the cost of the job that worked", () => {
    const first = run({ cost: usd("0.30"), finalStatus: "error" });
    const second = run({ cost: usd("0.20"), at: T0 + HOUR });
    const failed = run({ taskKey: "job-2", cost: usd("0.50"), escalated: true, at: T0 + 2 * HOUR });
    const { tasks } = detectOutcomes([first, second, failed], WINDOWS, ASOF);
    const result = computeLcso({
      workflowId: "support-bot",
      period: { from: T0, to: T0 + 30 * DAY },
      successDefinition: { id: "support", version: "2", maturationWindowMs: WINDOWS.maturationWindowMs },
      asOf: ASOF,
      tasks: tasks.map((t) => t.task),
    });
    expect(result.counts).toMatchObject({ success: 1, failure: 1, resolved: 2 });
    // $1.00 of spend over one finished job; the failed first try is part of what it cost.
    expect(result.components.model).toBe(usd("1.00"));
    expect(result.components.modelNonFinalSuccessRuns).toBe(usd("0.30"));
    expect(result.lcso.lcso1).toMatchObject({ reported: true });
    expect(result.flags).toContain("mostly-tier-c");
  });

  it("holds a fresh success as waiting until its maturation window passes", () => {
    const fresh = run({ at: ASOF - DAY });
    const { tasks } = detectOutcomes([fresh], WINDOWS, ASOF);
    const result = computeLcso({
      workflowId: "a",
      period: { from: T0, to: ASOF },
      successDefinition: { id: "support", version: "2", maturationWindowMs: WINDOWS.maturationWindowMs },
      asOf: ASOF,
      tasks: tasks.map((t) => t.task),
    });
    expect(result.counts).toMatchObject({ success: 0, pending: 1, pendingMaturing: 1 });
  });
});
