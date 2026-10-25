import { describe, expect, it } from "vitest";
import { usd } from "../src/money.js";
import { computeLcso, computeLcsoAggregate } from "../src/lcso.js";
import type { HumanBaseline, LcsoTask, OutcomeState } from "../src/lcso-types.js";
import { verdictOf } from "../src/verdict.js";
import { AS_OF, DAY, baseInput } from "./fixtures/lcso-base.js";

function task(id: string, state: OutcomeState, cost: string): LcsoTask {
  const runs = [{ runId: `${id}-r`, cost: usd(cost), startedAt: 0 }];
  return state === "PENDING" ? { taskId: id, state, runs } : { taskId: id, state, runs, resolvedAt: AS_OF - 10 * DAY };
}

const person = (cost: string): HumanBaseline => ({
  costPerOutcome: usd(cost),
  source: "owner",
  date: "2026-10-01",
  method: "minutes × hourly rate",
});

const verdict = (tasks: LcsoTask[], baseline?: HumanBaseline) =>
  verdictOf(computeLcso(baseInput(tasks, baseline ? { humanBaseline: baseline } : {})));

describe("verdict per agent", () => {
  it("has nothing to say with no jobs", () => {
    expect(verdict([])).toBe("no-data");
  });

  it("flags spend with no finished jobs", () => {
    expect(verdict([task("a", "FAILURE", "1"), task("b", "UNKNOWN", "1")])).toBe("spend-no-successes");
  });

  it("waits while every job is still in its window", () => {
    expect(verdict([task("a", "PENDING", "1")])).toBe("too-early");
  });

  it("says when a finished job costs at least the person estimate, before anything else", () => {
    const tasks = [task("a", "SUCCESS", "5"), task("b", "FAILURE", "5")];
    expect(verdict(tasks, person("10"))).toBe("dearer-than-person");
    expect(verdict(tasks, person("10.01"))).toBe("mostly-failures");
  });

  it("calls half or more of the spend on failures mostly failures", () => {
    expect(verdict([task("a", "SUCCESS", "1"), task("b", "FAILURE", "1")])).toBe("mostly-failures");
    expect(verdict([task("a", "SUCCESS", "1.01"), task("b", "FAILURE", "0.99")])).toBe("steady");
  });

  it("calls a bad job at 3× a typical one unpredictable", () => {
    const steady = Array.from({ length: 8 }, (_, i) => task(`s${i}`, "SUCCESS", "1"));
    expect(verdict([...steady, task("x", "SUCCESS", "3"), task("y", "SUCCESS", "3")])).toBe("unpredictable");
    expect(verdict([...steady, task("x", "SUCCESS", "2.99"), task("y", "SUCCESS", "2.99")])).toBe("steady");
  });

  it("works on totals alone, where share and spread are not reported", () => {
    const common = baseInput([]);
    const aggregate = (successCount: number, cost: string, baseline?: HumanBaseline) =>
      verdictOf(
        computeLcsoAggregate({ ...common, modelCost: usd(cost), successCount, ...(baseline ? { humanBaseline: baseline } : {}) }),
      );
    expect(aggregate(10, "5")).toBe("steady");
    expect(aggregate(0, "5")).toBe("spend-no-successes");
    expect(aggregate(1, "5", person("4"))).toBe("dearer-than-person");
    // A count with no spend yet (the month's report not imported) has nothing to divide.
    expect(aggregate(10, "0")).toBe("no-data");
    expect(aggregate(0, "0")).toBe("no-data");
  });
});
