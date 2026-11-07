import type { Nanodollars } from "./money.js";
import type { Tier } from "./pricing.js";
import type { TaskKind } from "./task-label.js";

/**
 * Predicting, for each candidate model, how good its work would be, how often
 * it would finish, and what it would cost (v3, phase 4).
 *
 * Quality and finishing are Beta posteriors: a prior, then the agent's own
 * evidence on that model. The prior is weak on purpose, worth four jobs, so
 * the customer's data outweighs it quickly. It comes from a cited public
 * benchmark when one is listed in `BENCHMARKS`, otherwise from the model's
 * tier, and every prediction says which.
 *
 * D8: a prediction informs suggestions and the decision log. It never moves
 * a call on its own; trials do (phase 5).
 */

/** A published result: a score from 0 to 1 for a model, with where it came from. */
export interface BenchmarkResult {
  readonly model: string;
  /** The kind of task it measures, or "all". */
  readonly kind: TaskKind | "all";
  readonly score: number;
  readonly source: string;
  /** YYYY-MM-DD the result was read. */
  readonly date: string;
}

/**
 * Cited benchmark results. Empty by the owner's decision (7 November 2026):
 * predictions start from the tier guess and learn from the customer's own
 * results. Any entry added later must carry its source and date.
 */
export const BENCHMARKS: readonly BenchmarkResult[] = [];

/** How good a tier's work is assumed to be before any evidence. Labelled as a guess wherever it shows. */
export const TIER_PRIOR: Readonly<Record<Tier, number>> = { frontier: 0.85, mid: 0.78, small: 0.65, open: 0.6 };
export const FINISH_PRIOR = 0.85;
/** A prior is worth this many jobs of evidence. */
export const PRIOR_WEIGHT = 4;

export interface Evidence {
  /** Answers that met the bar, and that fell short of it. */
  readonly met: number;
  readonly below: number;
  /** Calls or jobs that finished, and that did not. */
  readonly finished: number;
  readonly notFinished: number;
  /** Calls seen, and their total cost. */
  readonly calls: number;
  readonly cost: Nanodollars;
}

export const NO_EVIDENCE: Evidence = { met: 0, below: 0, finished: 0, notFinished: 0, calls: 0, cost: 0n };

export interface Candidate {
  readonly model: string;
  readonly tier: Tier;
  readonly evidence: Evidence;
  /** What a call would cost at this model's price with the agent's usual tokens; for models it has not used. */
  readonly estimatedCostPerCall?: Nanodollars | undefined;
}

export interface Interval {
  readonly mean: number;
  readonly low: number;
  readonly high: number;
}

export interface Prediction {
  readonly model: string;
  readonly quality: Interval;
  readonly finish: Interval;
  readonly costPerCall: Nanodollars | null;
  /** Cost per call × calls per job, over the chance of finishing. */
  readonly costPerFinishedJob: Nanodollars | null;
  /** 0 to 1: one minus the width of the 90% interval on quality. */
  readonly confidence: number;
  readonly evidence: { readonly calls: number; readonly judged: number };
  /** Where the cost comes from: the agent's own calls, or the list price with its usual tokens. */
  readonly costBasis: "measured" | "estimated" | "unknown";
  /** Where the starting point came from: a cited benchmark, or the tier. */
  readonly prior: string;
}

/**
 * Beta(α, β) as a mean and an approximate 90% interval. `trust` (0 to 1, from
 * the weekly check of past predictions) widens the interval where the router
 * has been wrong before, so it plays safer there.
 */
function beta(priorMean: number, successes: number, failures: number, trust = 1): Interval {
  const a = priorMean * PRIOR_WEIGHT + successes;
  const b = (1 - priorMean) * PRIOR_WEIGHT + failures;
  const mean = a / (a + b);
  const half = (1.645 * Math.sqrt((mean * (1 - mean)) / (a + b + 1))) / Math.max(0.25, trust);
  return { mean, low: Math.max(0, mean - half), high: Math.min(1, mean + half) };
}

function priorFor(model: string, tier: Tier, kind: TaskKind | undefined): { mean: number; label: string } {
  const cited =
    BENCHMARKS.find((b) => b.model === model && b.kind === kind) ?? BENCHMARKS.find((b) => b.model === model && b.kind === "all");
  return cited !== undefined
    ? { mean: cited.score, label: `${cited.source} (${cited.date})` }
    : { mean: TIER_PRIOR[tier], label: `tier prior (${tier}), not a benchmark` };
}

export function predictOne(c: Candidate, kind: TaskKind | undefined, callsPerJob: number, trust = 1): Prediction {
  const prior = priorFor(c.model, c.tier, kind);
  const e = c.evidence;
  const quality = beta(prior.mean, e.met, e.below, trust);
  const finish = beta(FINISH_PRIOR, e.finished, e.notFinished, trust);
  const measured = e.calls > 0 && e.cost > 0n;
  const perCall = measured ? e.cost / BigInt(e.calls) : (c.estimatedCostPerCall ?? null);
  // Calls per job and the chance of finishing are ratios; scaled by a million to stay in integers.
  const perJob =
    perCall === null ? null : (perCall * BigInt(Math.round(callsPerJob * 1_000_000))) / BigInt(Math.max(1, Math.round(finish.mean * 1_000_000)));
  return {
    model: c.model,
    quality,
    finish,
    costPerCall: perCall,
    costPerFinishedJob: perJob,
    confidence: Math.max(0, Math.min(1, (1 - (quality.high - quality.low)) * trust)),
    evidence: { calls: e.calls, judged: e.met + e.below },
    costBasis: measured ? "measured" : perCall === null ? "unknown" : "estimated",
    prior: prior.label,
  };
}

/** D9: how the owner trades quality against cost for an agent. */
export type RoutingMode =
  | { readonly kind: "same-quality" }
  | { readonly kind: "best-within-budget"; readonly budgetPerJob: Nanodollars }
  | { readonly kind: "best-value"; readonly valueOfFullQuality: Nanodollars };

export const DEFAULT_MODE: RoutingMode = { kind: "same-quality" };

/** How far below the current model's quality a candidate may sit and still count as "same quality". */
export const SAME_QUALITY_TOLERANCE = 0.02;

export interface Ranked extends Prediction {
  /** True when the candidate meets the mode's bar (same quality, within budget). */
  readonly eligible: boolean;
  readonly current: boolean;
  /** Why it ranks where it does, in a few words. */
  readonly note: string;
}

const byCost = (a: Prediction, b: Prediction): number => {
  if (a.costPerFinishedJob === null) return b.costPerFinishedJob === null ? 0 : 1;
  if (b.costPerFinishedJob === null) return -1;
  return a.costPerFinishedJob < b.costPerFinishedJob ? -1 : a.costPerFinishedJob > b.costPerFinishedJob ? 1 : 0;
};

/**
 * Every candidate, best first for the mode. When unsure, play safe: a
 * candidate is only "same quality" if its predicted quality is within
 * tolerance of the current model's, and ties go to the current model.
 */
export function rankModels(
  candidates: readonly Candidate[],
  opts: { kind?: TaskKind | undefined; current?: string | undefined; callsPerJob?: number; mode?: RoutingMode; trust?: number },
): Ranked[] {
  const mode = opts.mode ?? DEFAULT_MODE;
  const predictions = candidates.map((c) => predictOne(c, opts.kind, opts.callsPerJob ?? 1, opts.trust ?? 1));
  const current = predictions.find((p) => p.model === opts.current);

  const ranked = predictions.map((p): Ranked => {
    const isCurrent = p.model === opts.current;
    let eligible: boolean;
    let note: string;
    if (mode.kind === "same-quality") {
      eligible = current === undefined || isCurrent || p.quality.mean >= current.quality.mean - SAME_QUALITY_TOLERANCE;
      note = isCurrent ? "the model it uses now" : eligible ? "predicted as good as the current model" : "predicted worse than the current model";
    } else if (mode.kind === "best-within-budget") {
      eligible = p.costPerFinishedJob !== null && p.costPerFinishedJob <= mode.budgetPerJob;
      note = eligible ? "within the budget per job" : "over the budget per job";
    } else {
      eligible = p.costPerFinishedJob !== null;
      note = "value: quality worth more than it costs";
    }
    return { ...p, eligible, current: isCurrent, note };
  });

  const value = (p: Prediction): number =>
    mode.kind === "best-value" && p.costPerFinishedJob !== null
      ? p.quality.mean * Number(mode.valueOfFullQuality) - Number(p.costPerFinishedJob)
      : 0;

  return ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (mode.kind === "best-within-budget") return b.quality.mean - a.quality.mean || byCost(a, b);
    if (mode.kind === "best-value") return value(b) - value(a);
    // Below the bar, the nearest to it comes first: cost doesn't redeem worse work.
    if (!a.eligible) return b.quality.mean - a.quality.mean;
    const cost = byCost(a, b);
    if (cost !== 0) return cost;
    return a.current ? -1 : b.current ? 1 : b.quality.mean - a.quality.mean;
  });
}
