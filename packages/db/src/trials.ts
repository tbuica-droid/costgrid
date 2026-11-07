import { randomUUID } from "node:crypto";
import type { Nanodollars } from "@costgrid/core";
import type { Db } from "./database.js";
import { DEFAULT_QUALITY_BAR_MILLI, QualityRepository } from "./quality.js";

/**
 * Trials: a candidate model tested on a share of one agent's jobs, against the
 * rest on its current model at the same time (v3, phase 5).
 *
 * Judged per job (a run), arm against arm:
 *   - finished: no failed call, not cut off or refused, and not reported failed;
 *   - quality: below the bar on a failed format check, an edited, rejected or
 *     handed-off signal, or a reported score under the agent's bar; met on a
 *     passed check, an accepted signal or a score at or above the bar;
 *   - cost per good job: the arm's spend over its jobs that finished and were
 *     not below the bar.
 * Side-by-side grades add the candidate's win rate.
 *
 * A trial passes only with enough jobs on both arms, no worse finishing or
 * quality (D13: never worse than the current model, within 2 points), and a
 * lower cost per good job. It fails early on a burst of errors.
 */

export type TrialStatus = "running" | "passed" | "failed" | "stopped" | "applied" | "reverted";
export type Arm = "candidate" | "baseline";

export interface Trial {
  readonly id: string;
  readonly agentId: string;
  readonly baselineModel: string;
  readonly candidateModel: string;
  readonly shareMilli: number;
  readonly minJobs: number;
  readonly status: TrialStatus;
  readonly why: string | null;
  readonly policyId: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface ArmStats {
  readonly jobs: number;
  readonly calls: number;
  readonly errors: number;
  readonly finished: number;
  readonly met: number;
  readonly below: number;
  readonly good: number;
  readonly cost: Nanodollars;
  readonly finishedShare: number | null;
  readonly qualityShare: number | null;
  readonly errorRate: number | null;
  readonly costPerGoodJob: Nanodollars | null;
}

export interface TrialJudgement {
  readonly status: "running" | "passed" | "failed";
  readonly why: string;
  readonly candidate: ArmStats;
  readonly baseline: ArmStats;
  readonly grades: { readonly candidate: number; readonly baseline: number; readonly tie: number };
}

export const DEFAULT_SHARE_MILLI = 50;
export const DEFAULT_MIN_JOBS = 100;
/** How far finishing or quality may fall, in points, and still count as no worse. */
export const NO_WORSE_TOLERANCE = 0.02;
export const MIN_JUDGED = 10;
export const FAST_FAIL_ERRORS = 5;
/** Spot checks needed before the grader's agreement with the owner is judged. */
export const MIN_SPOT_CHECKS = 10;
/** Below this agreement with the owner, grades stop counting in trials. */
export const MIN_GRADER_AGREEMENT = 0.7;

const COLUMNS = `id, agent_id AS agentId, baseline_model AS baselineModel, candidate_model AS candidateModel,
  share_milli AS shareMilli, min_jobs AS minJobs, status, why, policy_id AS policyId,
  started_at AS startedAt, ended_at AS endedAt`;

/** Is this job in the trial's candidate arm? A stable hash, so every call of a job lands on the same model. */
export function inCandidateArm(trialId: string, jobKey: string, shareMilli: number): boolean {
  let h = 0x811c9dc5;
  const text = `${trialId}:${jobKey}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 1000 < shareMilli;
}

const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

export class TrialsRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Start a trial. Refused for critical agents, and while the agent has one running. */
  start(
    tenantId: string,
    t: { agentId: string; baselineModel: string; candidateModel: string; shareMilli?: number; minJobs?: number },
    at = Date.now(),
  ): Trial | string {
    if (this.agentSettings(tenantId, t.agentId).critical) return "this agent's work is marked critical, so it is never tested on";
    if (this.runningFor(tenantId, t.agentId) !== undefined) return "this agent already has a trial running";
    if (t.baselineModel === t.candidateModel) return "the candidate must differ from the model it uses now";
    const id = `trial_${randomUUID().slice(0, 8)}`;
    this.#db
      .prepare(
        `INSERT INTO trials (tenant_id, id, agent_id, baseline_model, candidate_model, share_milli, min_jobs, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(tenantId, id, t.agentId, t.baselineModel, t.candidateModel, t.shareMilli ?? DEFAULT_SHARE_MILLI, t.minJobs ?? DEFAULT_MIN_JOBS, at);
    return this.get(tenantId, id)!;
  }

  get(tenantId: string, id: string): Trial | undefined {
    return this.#db.prepare(`SELECT ${COLUMNS} FROM trials WHERE tenant_id = ? AND id = ?`).get(tenantId, id) as Trial | undefined;
  }

  list(tenantId: string, status?: TrialStatus): Trial[] {
    return this.#db
      .prepare(`SELECT ${COLUMNS} FROM trials WHERE tenant_id = ? ${status ? "AND status = ?" : ""} ORDER BY started_at DESC LIMIT 200`)
      .all(...(status ? [tenantId, status] : [tenantId])) as Trial[];
  }

  /** Every organisation's trials in a status: for the review job. */
  allWithStatus(status: TrialStatus): (Trial & { tenantId: string })[] {
    return this.#db
      .prepare(`SELECT tenant_id AS tenantId, ${COLUMNS} FROM trials WHERE status = ?`)
      .all(status) as (Trial & { tenantId: string })[];
  }

  /** On the request path: one indexed read. */
  runningFor(tenantId: string, agentId: string): Trial | undefined {
    return this.#db
      .prepare(`SELECT ${COLUMNS} FROM trials WHERE tenant_id = ? AND agent_id = ? AND status = 'running' LIMIT 1`)
      .get(tenantId, agentId) as Trial | undefined;
  }

  setStatus(tenantId: string, id: string, status: TrialStatus, why: string, at = Date.now(), policyId?: string): void {
    this.#db
      .prepare(
        `UPDATE trials SET status = ?, why = ?, ended_at = COALESCE(ended_at, ?), policy_id = COALESCE(?, policy_id)
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(status, why, at, policyId ?? null, tenantId, id);
  }

  /** Whether the owner has applied a passed trial for this agent before: the gate for switching on its own (D14). */
  hasApplied(tenantId: string, agentId: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM trials WHERE tenant_id = ? AND agent_id = ? AND status IN ('applied', 'reverted') LIMIT 1")
        .get(tenantId, agentId) !== undefined
    );
  }

  // ----------------------------------------------------------- settings

  agentSettings(tenantId: string, agentId: string): { critical: boolean; switching: "suggest" | "auto" } {
    const row = this.#db
      .prepare("SELECT critical, switching FROM agents WHERE tenant_id = ? AND id = ?")
      .get(tenantId, agentId) as { critical: number; switching: string } | undefined;
    return { critical: row?.critical === 1, switching: row?.switching === "auto" ? "auto" : "suggest" };
  }

  setAgentSettings(tenantId: string, agentId: string, s: { critical?: boolean; switching?: "suggest" | "auto" }): boolean {
    const current = this.agentSettings(tenantId, agentId);
    return (
      this.#db
        .prepare("UPDATE agents SET critical = ?, switching = ? WHERE tenant_id = ? AND id = ?")
        .run((s.critical ?? current.critical) ? 1 : 0, s.switching ?? current.switching, tenantId, agentId).changes === 1
    );
  }

  /**
   * Grading, and spot checks. Spot checks are their own switch: graded answers
   * are held in memory for the owner to read only while it is on.
   */
  grading(tenantId: string): { enabled: boolean; shareMilli: number; spotChecks: boolean } {
    const row = this.#db
      .prepare("SELECT grading, grading_share_milli AS shareMilli, spot_checks AS spot FROM tenant_settings WHERE tenant_id = ?")
      .get(tenantId) as { grading: number; shareMilli: number; spot: number } | undefined;
    return { enabled: row?.grading === 1, shareMilli: row?.shareMilli ?? 15, spotChecks: row?.spot === 1 };
  }

  setSpotChecks(tenantId: string, on: boolean, at = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO tenant_settings (tenant_id, spot_checks, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET spot_checks = excluded.spot_checks, updated_at = excluded.updated_at`,
      )
      .run(tenantId, on ? 1 : 0, at);
  }

  setGrading(tenantId: string, enabled: boolean, shareMilli: number, at = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO tenant_settings (tenant_id, grading, grading_share_milli, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET grading = excluded.grading,
           grading_share_milli = excluded.grading_share_milli, updated_at = excluded.updated_at`,
      )
      .run(tenantId, enabled ? 1 : 0, shareMilli, at);
  }

  // -------------------------------------------------------------- grades

  recordGrade(
    tenantId: string,
    g: { trialId: string; callId: string; runId: string; verdict: Arm | "tie"; graderModel: string },
    at = Date.now(),
  ): void {
    this.#db
      .prepare(
        `INSERT INTO grades (tenant_id, trial_id, call_id, run_id, verdict, grader_model, graded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, call_id) DO NOTHING`,
      )
      .run(tenantId, g.trialId, g.callId, g.runId, g.verdict, g.graderModel, at);
  }

  /** Graded jobs the owner has not checked yet, newest first: the spot-check queue. */
  spotChecks(tenantId: string, limit = 10): { callId: string; runId: string; trialId: string; verdict: string; gradedAt: number }[] {
    return this.#db
      .prepare(
        `SELECT call_id AS callId, run_id AS runId, trial_id AS trialId, verdict, graded_at AS gradedAt
         FROM grades WHERE tenant_id = ? AND owner_verdict IS NULL ORDER BY graded_at DESC LIMIT ?`,
      )
      .all(tenantId, limit) as { callId: string; runId: string; trialId: string; verdict: string; gradedAt: number }[];
  }

  /** `unsure` records that the owner looked but could not tell. */
  setOwnerVerdict(tenantId: string, callId: string, verdict: Arm | "tie" | "unsure", at = Date.now()): boolean {
    return (
      this.#db
        .prepare("UPDATE grades SET owner_verdict = ?, checked_at = ? WHERE tenant_id = ? AND call_id = ?")
        .run(verdict, at, tenantId, callId).changes === 1
    );
  }

  // ------------------------------------------------------------- judging

  /** Per-job figures for one arm of a trial, or for the calls a switch moved. */
  #arm(tenantId: string, where: string, params: unknown[], barMilli: number): ArmStats {
    const runs = this.#db
      .prepare(
        `WITH c AS (
           SELECT run_id, cost_total, outcome, answer_check,
                  ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY started_at DESC, id DESC) AS last_n
           FROM calls WHERE tenant_id = ? AND purpose = 'work' AND outcome != 'blocked' ${where}
         )
         SELECT c.run_id AS runId, COUNT(*) AS calls,
                COALESCE(SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END), 0) AS cost,
                SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
                MAX(CASE WHEN last_n = 1 THEN answer_check END) AS lastCheck,
                o.succeeded, o.quality_milli AS q, o.signal
         FROM c LEFT JOIN outcomes o ON o.tenant_id = ? AND o.run_id = c.run_id
         GROUP BY c.run_id`,
      )
      .safeIntegers(true)
      .all(tenantId, ...params, tenantId) as {
      calls: bigint;
      cost: bigint;
      errors: bigint;
      lastCheck: string | null;
      succeeded: bigint | null;
      q: bigint | null;
      signal: string | null;
    }[];

    let calls = 0;
    let errors = 0;
    let finished = 0;
    let met = 0;
    let below = 0;
    let good = 0;
    let cost = 0n;
    for (const r of runs) {
      calls += Number(r.calls);
      errors += Number(r.errors);
      cost += r.cost;
      const done =
        Number(r.errors) === 0 && r.lastCheck !== "cut-off" && r.lastCheck !== "refusal" && (r.succeeded === null || r.succeeded === 1n);
      const low =
        r.lastCheck === "not-json" ||
        r.lastCheck === "missing-field" ||
        r.signal === "edited" ||
        r.signal === "rejected" ||
        r.signal === "handed-off" ||
        (r.q !== null && Number(r.q) < barMilli);
      const high = !low && (r.lastCheck === "pass" || r.signal === "accepted" || r.q !== null);
      if (done) finished += 1;
      if (low) below += 1;
      if (high) met += 1;
      if (done && !low) good += 1;
    }
    const jobs = runs.length;
    return {
      jobs,
      calls,
      errors,
      finished,
      met,
      below,
      good,
      cost,
      finishedShare: share(finished, jobs),
      qualityShare: met + below >= MIN_JUDGED ? share(met, met + below) : null,
      errorRate: share(errors, calls),
      costPerGoodJob: good === 0 ? null : cost / BigInt(good),
    };
  }

  armStats(tenantId: string, trial: Trial, arm: Arm): ArmStats {
    const bar = new QualityRepository(this.#db).forAgent(tenantId, trial.agentId).barMilli ?? DEFAULT_QUALITY_BAR_MILLI;
    return this.#arm(tenantId, "AND trial_id = ? AND trial_arm = ?", [trial.id, arm], bar);
  }

  /** What the calls a switch moved have done since it was applied. */
  switchStats(tenantId: string, trial: Trial): ArmStats {
    const bar = new QualityRepository(this.#db).forAgent(tenantId, trial.agentId).barMilli ?? DEFAULT_QUALITY_BAR_MILLI;
    return this.#arm(
      tenantId,
      "AND agent_id = ? AND requested_model = ? AND model = ? AND routed = 1 AND trial_id IS NULL AND started_at >= ?",
      [trial.agentId, trial.baselineModel, trial.candidateModel, trial.endedAt ?? trial.startedAt],
      bar,
    );
  }

  /**
   * How often the grader picked the same answer as the owner on spot checks
   * ("can't tell" left out). Graders favour longer answers and their own
   * family; this is the check on that (v3, phase 6).
   */
  graderAgreement(tenantId: string): { checked: number; agreed: number; rate: number | null; trusted: boolean } {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS checked, COALESCE(SUM(CASE WHEN owner_verdict = verdict THEN 1 ELSE 0 END), 0) AS agreed
         FROM grades WHERE tenant_id = ? AND owner_verdict IS NOT NULL AND owner_verdict != 'unsure'`,
      )
      .get(tenantId) as { checked: number; agreed: number };
    const rate = row.checked === 0 ? null : row.agreed / row.checked;
    return { ...row, rate, trusted: row.checked < MIN_SPOT_CHECKS || (rate ?? 1) >= MIN_GRADER_AGREEMENT };
  }

  grades(tenantId: string, trialId: string): TrialJudgement["grades"] {
    const out = { candidate: 0, baseline: 0, tie: 0 };
    for (const r of this.#db
      .prepare("SELECT verdict, COUNT(*) AS n FROM grades WHERE tenant_id = ? AND trial_id = ? GROUP BY verdict")
      .all(tenantId, trialId) as { verdict: keyof typeof out; n: number }[]) {
      out[r.verdict] = r.n;
    }
    return out;
  }

  /** Whether this agent has quality evidence beyond inference: the gate for switching on its own (D14). */
  hasQualitySignals(tenantId: string, trial: Trial): boolean {
    const c = this.armStats(tenantId, trial, "candidate");
    const g = this.grades(tenantId, trial.id);
    return c.met + c.below >= MIN_JUDGED || g.candidate + g.baseline + g.tie >= MIN_JUDGED;
  }

  judge(tenantId: string, trial: Trial): TrialJudgement {
    const candidate = this.armStats(tenantId, trial, "candidate");
    const baseline = this.armStats(tenantId, trial, "baseline");
    const grades = this.grades(tenantId, trial.id);
    const result = (status: TrialJudgement["status"], why: string): TrialJudgement => ({ status, why, candidate, baseline, grades });
    const pct = (x: number) => `${Math.round(x * 100)}%`;

    if (
      candidate.errors >= FAST_FAIL_ERRORS &&
      (candidate.errorRate ?? 0) >= (baseline.errorRate ?? 0) + 0.05
    ) {
      return result("failed", `${candidate.errors} of the candidate's calls failed (${pct(candidate.errorRate ?? 0)} against ${pct(baseline.errorRate ?? 0)})`);
    }
    if (candidate.jobs < trial.minJobs || baseline.jobs < trial.minJobs) {
      return result("running", `${candidate.jobs} and ${baseline.jobs} of the ${trial.minJobs} jobs needed on each side`);
    }
    if ((candidate.finishedShare ?? 0) < (baseline.finishedShare ?? 0) - NO_WORSE_TOLERANCE) {
      return result("failed", `fewer jobs finished: ${pct(candidate.finishedShare ?? 0)} against ${pct(baseline.finishedShare ?? 0)}`);
    }
    if (candidate.qualityShare !== null && baseline.qualityShare !== null && candidate.qualityShare < baseline.qualityShare - NO_WORSE_TOLERANCE) {
      return result("failed", `lower quality: ${pct(candidate.qualityShare)} up to standard against ${pct(baseline.qualityShare)}`);
    }
    const graded = grades.candidate + grades.baseline;
    // A grader the owner disagrees with too often is not counted.
    if (graded >= MIN_JUDGED && this.graderAgreement(tenantId).trusted && grades.candidate / graded < 0.45) {
      return result("failed", `the grader preferred the current model in ${grades.baseline} of ${graded} comparisons`);
    }
    if (candidate.costPerGoodJob === null || baseline.costPerGoodJob === null || candidate.costPerGoodJob >= baseline.costPerGoodJob) {
      return result("failed", "no cheaper per good job");
    }
    const saving = 1 - Number(candidate.costPerGoodJob) / Number(baseline.costPerGoodJob);
    return result("passed", `as good, and ${pct(saving)} cheaper per good job over ${candidate.jobs} and ${baseline.jobs} jobs`);
  }
}
