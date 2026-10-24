import { describe, expect, it } from "vitest";
import { sumNano } from "../src/money.js";
import { compareRatio, ratio, type Ratio } from "../src/ratio.js";
import { computeLcso } from "../src/lcso.js";
import type { HumanTimeEntry, LcsoInput, LcsoResult, LcsoTask, OutcomeState, Reported } from "../src/lcso-types.js";
import { AS_OF, DAY, WINDOW, baseInput } from "./fixtures/lcso-base.js";

/**
 * Invariants of the LCSO engine over generated inputs. The generator is a
 * seeded mulberry32, so every run checks the same cases and a failure names
 * its seed.
 */

const CASES = 200;
const STATES: readonly OutcomeState[] = ["SUCCESS", "SUCCESS", "SUCCESS", "FAILURE", "ABANDONED", "PENDING", "UNKNOWN"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (rng: Rng, n: number) => Math.floor(rng() * n);
const pick = <T>(rng: Rng, items: readonly T[]): T => items[int(rng, items.length)]!;

function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(rng, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function genTask(rng: Rng, index: number): LcsoTask {
  const taskId = `t${index}`;
  const state = pick(rng, STATES);
  const runs = Array.from({ length: int(rng, 5) }, (_, j) => ({
    runId: `${taskId}-r${j}`,
    cost: BigInt(int(rng, 2_000_000_000)),
    startedAt: AS_OF - 30 * DAY + int(rng, 4) * 1000,
  }));
  if (state === "PENDING") return { taskId, state, runs };
  const resolvedAt = AS_OF - int(rng, 20 * DAY);
  const tier = pick(rng, ["A", "B", "C", undefined] as const);
  const base: LcsoTask = { taskId, state, runs, resolvedAt, ...(tier ? { evidenceTier: tier } : {}) };
  if (state === "SUCCESS" && rng() < 0.2) return { ...base, reversedAt: resolvedAt + int(rng, AS_OF - resolvedAt + 1) };
  if (runs.length > 1 && rng() < 0.2) return { ...base, finalRunId: pick(rng, runs).runId };
  return base;
}

function genInput(seed: number): LcsoInput {
  const rng = mulberry32(seed);
  const tasks = Array.from({ length: int(rng, 30) }, (_, i) => genTask(rng, i));
  const entries: HumanTimeEntry[] = Array.from({ length: int(rng, 6) }, () => {
    const entry: HumanTimeEntry = {
      activity: pick(rng, ["review", "handoff"] as const),
      minutes: int(rng, 120),
      hourlyRate: BigInt(int(rng, 100_000_000_000)),
      basis: pick(rng, ["measured", "estimated"] as const),
    };
    return tasks.length > 0 && rng() < 0.7 ? { ...entry, taskId: pick(rng, tasks).taskId } : entry;
  });
  return baseInput(tasks, {
    toolCosts: [{ ref: "api", amount: BigInt(int(rng, 5_000_000_000)) }],
    fixedCosts: [{ ref: "gl", amount: BigInt(int(rng, 5_000_000_000)), allocationKey: "tasks" }],
    human: { entries, reworkTracked: false },
  });
}

/** Runs a property over every seed, naming the seed of the first failure. */
function forEachSeed(property: (seed: number) => void): void {
  for (let seed = 1; seed <= CASES; seed++) {
    try {
      property(seed);
    } catch (error) {
      throw new Error(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

const atMost = (a: Ratio, b: Ratio) => compareRatio(a, b) <= 0;
const val = <T>(figure: Reported<T>): T | undefined => (figure.reported ? figure.value : undefined);

/** A task that counts as a success in `result` and has a run to split. */
function successTask(input: LcsoInput, result: LcsoResult): LcsoTask | undefined {
  if (result.counts.success === 0) return undefined;
  return input.tasks.find((t) => {
    if (t.state !== "SUCCESS" || t.runs.length === 0) return false;
    const end = t.resolvedAt! + WINDOW;
    return end <= AS_OF && (t.reversedAt === undefined || t.reversedAt > end);
  });
}

describe("LCSO invariants", () => {
  it("keeps FCS within [0, 1] and the layers ordered", () => forEachSeed((seed) => {
    const result = computeLcso(genInput(seed));
    const fcs = val(result.failureCostShare);
    if (fcs) expect(atMost(ratio(0n, 1n), fcs) && atMost(fcs, ratio(1n, 1n))).toBe(true);
    const { lcso1, lcso2, lcso3 } = result.lcso;
    if (lcso1.reported && lcso2.reported && lcso3.reported) {
      expect(atMost(lcso1.value, lcso2.value) && atMost(lcso2.value, lcso3.value)).toBe(true);
    }
  }));

  it("conserves spend and tasks, and orders the percentiles", () => forEachSeed((seed) => {
    const input = genInput(seed);
    const result = computeLcso(input);
    const allRuns = sumNano(input.tasks.flatMap((t) => t.runs.map((r) => r.cost)));
    expect(result.components.model + result.carriedForward.model).toBe(allRuns);
    const { success, failure, abandoned, unknown, resolved, pending } = result.counts;
    expect(success + failure + abandoned + unknown).toBe(resolved);
    expect(resolved + pending).toBe(input.tasks.length);
    const spread = val(result.spread);
    if (spread) {
      const max = input.tasks.reduce((m, t) => {
        const cost = sumNano(t.runs.map((r) => r.cost));
        return cost > m ? cost : m;
      }, 0n);
      expect(spread.p50 <= spread.p90 && spread.p90 <= spread.p99 && spread.p99 <= max).toBe(true);
    }
  }));

  it("never flatters LCSO-1 or the success rate when a failure is added", () => forEachSeed((seed) => {
    const input = genInput(seed);
    const before = computeLcso(input);
    const failed: LcsoTask = { taskId: "extra", state: "FAILURE", resolvedAt: AS_OF - DAY, runs: [{ runId: "extra-r", cost: 1n, startedAt: 0 }] };
    const after = computeLcso({ ...input, tasks: [...input.tasks, failed] });
    const [l1Before, l1After] = [val(before.lcso.lcso1), val(after.lcso.lcso1)];
    if (l1Before && l1After) expect(atMost(l1Before, l1After)).toBe(true);
    const [rateBefore, rateAfter] = [val(before.rates.success), val(after.rates.success)];
    if (rateBefore && rateAfter) expect(atMost(rateAfter, rateBefore)).toBe(true);
  }));

  it("charges a split retry to failure, without changing the success rate", () => forEachSeed((seed) => {
    const input = genInput(seed);
    const before = computeLcso(input);
    const target = successTask(input, before);
    if (!target) return;

    // Move part of the final run's cost into a new, earlier run.
    const final = target.finalRunId ?? [...target.runs].sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1)).at(-1)!.runId;
    const earliest = Math.min(...target.runs.map((r) => r.startedAt));
    const runs = target.runs.flatMap((run) => {
      if (run.runId !== final) return [run];
      const moved = run.cost / 2n;
      return [{ runId: `${target.taskId}-split`, cost: moved, startedAt: earliest - 1 }, { ...run, cost: run.cost - moved }];
    });
    const split: LcsoTask = { ...target, runs, finalRunId: final };
    const after = computeLcso({ ...input, tasks: input.tasks.map((t) => (t === target ? split : t)) });

    expect(after.rates.success).toEqual(before.rates.success);
    const [fcsBefore, fcsAfter] = [val(before.failureCostShare), val(after.failureCostShare)];
    if (fcsBefore && fcsAfter) expect(atMost(fcsBefore, fcsAfter)).toBe(true);
  }));

  it("does not depend on the order of tasks or runs", () => forEachSeed((seed) => {
    const input = genInput(seed);
    const rng = mulberry32(seed ^ 0x5bd1e995);
    const shuffled = shuffle(rng, input.tasks).map((t) => ({ ...t, runs: shuffle(rng, t.runs) }));
    const entries = shuffle(rng, input.human?.entries ?? []);
    expect(computeLcso({ ...input, tasks: shuffled, human: { entries, reworkTracked: false } })).toEqual(computeLcso(input));
  }));
});
