import type { EvidenceTier, LcsoTask, OutcomeState } from "./lcso-types.js";
import type { Nanodollars } from "./money.js";
import type { RunStatus } from "./run-status.js";

/**
 * Whether each job got done, inferred from how the agent behaved (method
 * §5.4, tier C) unless the owner's software reported it (tier B).
 *
 * Runs are grouped into jobs by an id the developer sends (`x-costgrid-task`)
 * or by a one-way code of the job's first message (`task-fingerprint.ts`).
 * Then, first rule that applies:
 *
 * 1. Reported by the owner's software: that answer. Inference never
 *    overrides it.
 * 2. Handed to a person: did not finish.
 * 3. Stopped by a CostGrid limit: abandoned.
 * 4. Ended in an error, cut off, or declined: did not finish.
 * 5. Ended normally and the job can be recognised again: finished, which the
 *    LCSO engine holds as pending until the maturation window passes. Asked
 *    again within the re-run window, the earlier attempt did not finish;
 *    asked again later but inside the maturation window, the success is
 *    reversed.
 * 6. Ended normally but the job cannot be recognised: unknown. A re-run could
 *    not have been seen, so calling it finished would be a claim without
 *    evidence. The method counts unknown as failure, and says how many.
 *
 * Pure: no clock, no I/O. `asOf` is the moment of computation.
 */

export type TaskSource = "header" | "fingerprint" | "none";

/** One run, as the proxy recorded it. A sub-agent's run is folded into its parent's before this. */
export interface RunSummary {
  readonly runId: string;
  /** The developer's job id or the opening's code. Absent when neither was available. */
  readonly taskKey?: string;
  readonly taskSource: TaskSource;
  /** How many messages the first call carried: a growing count is one conversation continuing. */
  readonly turns?: number;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly cost: Nanodollars;
  /** How the run's last call ended. */
  readonly finalStatus: RunStatus;
  /** Whether any call in the run used a tool that hands the job to a person. */
  readonly escalated: boolean;
  /** The latest outcome the owner's software reported for this run. */
  readonly reported?: { readonly succeeded: boolean; readonly at: number };
}

/** Why a job ended up where it did, in the order they were found. */
export type Signal =
  | "reported"
  | "handed-off"
  | "blocked"
  | "error"
  | "truncated"
  | "refused"
  | "asked-again"
  | "reversed"
  | "finished"
  | "no-identity"
  | "shared-opening";

export interface DetectedTask {
  readonly task: LcsoTask;
  readonly source: TaskSource;
  readonly signals: readonly Signal[];
}

export interface Detection {
  readonly tasks: DetectedTask[];
  /** Attempts whose opening was too common to match, treated as unidentified. */
  readonly sharedOpenings: number;
}

export interface DetectionWindows {
  /** Asked again within this long after an attempt ended: that attempt did not finish. */
  readonly reRunWindowMs: number;
  /** A finished job asked again within this long is reversed. */
  readonly maturationWindowMs: number;
}

/** A conversation continuing (more messages, soon after) is the same attempt, not a retry. */
export const CONTINUATION_GAP_MS = 10 * 60 * 1000;
/** More attempts than this on one opening is a template, not one job tried again. */
export const MAX_ATTEMPTS_PER_OPENING = 5;

interface Attempt {
  readonly runs: RunSummary[];
  key: string | undefined;
  source: TaskSource;
  sharedOpening: boolean;
}

const byStart = (a: RunSummary, b: RunSummary): number =>
  a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);

const first = (a: Attempt): RunSummary => a.runs[0]!;
const last = (a: Attempt): RunSummary => a.runs[a.runs.length - 1]!;
const endOf = (a: Attempt): number => Math.max(...a.runs.map((r) => r.endedAt));

/** Runs into attempts: consecutive runs of one conversation merge. */
function attemptsOf(runs: readonly RunSummary[]): Attempt[] {
  const attempts: Attempt[] = [];
  const open = new Map<string, Attempt>();
  for (const run of [...runs].sort(byStart)) {
    const key = run.taskSource === "none" ? undefined : run.taskKey;
    const group = key === undefined ? undefined : `${run.taskSource}\u0000${key}`;
    const previous = group === undefined ? undefined : open.get(group);
    const prior = previous === undefined ? undefined : last(previous);
    const continues =
      prior !== undefined &&
      run.turns !== undefined &&
      prior.turns !== undefined &&
      run.turns > prior.turns &&
      run.startedAt - prior.endedAt <= CONTINUATION_GAP_MS;
    if (continues) {
      previous!.runs.push(run);
      continue;
    }
    const attempt: Attempt = { runs: [run], key, source: key === undefined ? "none" : run.taskSource, sharedOpening: false };
    attempts.push(attempt);
    if (group !== undefined) open.set(group, attempt);
  }
  return attempts;
}

/** A fingerprint seen on overlapping attempts belongs to a template, not to one job. */
function guardSharedOpenings(attempts: Attempt[]): void {
  const byKey = new Map<string, Attempt[]>();
  for (const a of attempts) {
    if (a.source !== "fingerprint" || a.key === undefined) continue;
    byKey.set(a.key, [...(byKey.get(a.key) ?? []), a]);
  }
  for (const group of byKey.values()) {
    const overlapping = group.some((a, i) => group.slice(i + 1).some((b) => first(b).startedAt < endOf(a)));
    if (overlapping) for (const a of group) unidentify(a);
  }
}

function unidentify(a: Attempt): void {
  a.key = undefined;
  a.source = "none";
  a.sharedOpening = true;
}

/** Attempts of one job, chained by the re-run window; a later return inside the maturation window reverses. */
function chain(attempts: Attempt[], windows: DetectionWindows, asOf: number): { attempts: Attempt[]; reversedAt?: number }[] {
  const jobs: { attempts: Attempt[]; reversedAt?: number }[] = [];
  const open = new Map<string, { attempts: Attempt[]; reversedAt?: number }>();
  for (const attempt of attempts) {
    if (attempt.key === undefined) {
      jobs.push({ attempts: [attempt] });
      continue;
    }
    const group = `${attempt.source}\u0000${attempt.key}`;
    const job = open.get(group);
    if (job !== undefined) {
      const gap = first(attempt).startedAt - endOf(job.attempts[job.attempts.length - 1]!);
      if (gap <= windows.reRunWindowMs) {
        job.attempts.push(attempt);
        continue;
      }
      const lastStart = first(attempt).startedAt;
      if (gap <= windows.maturationWindowMs && lastStart <= asOf) job.reversedAt = lastStart;
    }
    const next = { attempts: [attempt] };
    jobs.push(next);
    open.set(group, next);
  }

  // A template that keeps coming back is not one job being retried.
  return jobs.flatMap((job) => {
    if (job.attempts[0]!.source !== "fingerprint" || job.attempts.length <= MAX_ATTEMPTS_PER_OPENING) return [job];
    return job.attempts.map((a) => {
      unidentify(a);
      return { attempts: [a] };
    });
  });
}

function decide(
  attempts: Attempt[],
  reversedAt: number | undefined,
): { state: OutcomeState; tier: EvidenceTier; resolvedAt: number; signals: Signal[]; reversedAt?: number } {
  const runs = attempts.flatMap((a) => a.runs);
  const final = last(attempts[attempts.length - 1]!);
  const end = endOf(attempts[attempts.length - 1]!);
  const signals: Signal[] = [];
  if (attempts.length > 1) signals.push("asked-again");
  if (attempts.some((a) => a.sharedOpening)) signals.push("shared-opening");

  const reports = runs.filter((r) => r.reported !== undefined).map((r) => r.reported!);
  if (reports.length > 0) {
    const latest = reports.reduce((a, b) => (b.at >= a.at ? b : a));
    // A report may arrive before the run's last call is recorded; resolution is never before the work.
    const resolvedAt = Math.max(latest.at, first(attempts[0]!).startedAt);
    return { state: latest.succeeded ? "SUCCESS" : "FAILURE", tier: "B", resolvedAt, signals: [...signals, "reported"] };
  }
  if (runs.some((r) => r.escalated)) return { state: "FAILURE", tier: "C", resolvedAt: end, signals: [...signals, "handed-off"] };
  if (final.finalStatus === "blocked") return { state: "ABANDONED", tier: "C", resolvedAt: end, signals: [...signals, "blocked"] };
  if (final.finalStatus !== "ok") {
    return { state: "FAILURE", tier: "C", resolvedAt: end, signals: [...signals, final.finalStatus] };
  }
  if (attempts[0]!.source === "none") return { state: "UNKNOWN", tier: "C", resolvedAt: end, signals: [...signals, "no-identity"] };
  return {
    state: "SUCCESS",
    tier: "C",
    resolvedAt: end,
    signals: [...signals, "finished", ...(reversedAt !== undefined ? (["reversed"] as const) : [])],
    ...(reversedAt !== undefined && reversedAt >= end ? { reversedAt } : {}),
  };
}

/** Every job in these runs (one agent's), with its state, evidence and reasons. */
export function detectOutcomes(runs: readonly RunSummary[], windows: DetectionWindows, asOf: number): Detection {
  const attempts = attemptsOf(runs);
  guardSharedOpenings(attempts);
  const jobs = chain(attempts, windows, asOf);

  const tasks = jobs.map(({ attempts: own, reversedAt }): DetectedTask => {
    const decision = decide(own, reversedAt);
    const runsOf = own.flatMap((a) => a.runs);
    const final = last(own[own.length - 1]!);
    const head = first(own[0]!);
    return {
      source: own[0]!.source,
      signals: decision.signals,
      task: {
        taskId: own[0]!.key === undefined ? `run:${head.runId}` : `${own[0]!.source}:${own[0]!.key}:${head.runId}`,
        state: decision.state,
        evidenceTier: decision.tier,
        resolvedAt: decision.resolvedAt,
        runs: runsOf.map((r) => ({ runId: r.runId, cost: r.cost, startedAt: r.startedAt })),
        finalRunId: final.runId,
        ...(decision.reversedAt !== undefined ? { reversedAt: decision.reversedAt } : {}),
      },
    };
  });
  return { tasks, sharedOpenings: attempts.filter((a) => a.sharedOpening).length };
}
