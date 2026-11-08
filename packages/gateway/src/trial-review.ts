import {
  type AuditActor,
  type AuditLog,
  CostGridRepository,
  type Db,
  SYSTEM_ACTOR,
  type Trial,
  TrialsRepository,
} from "@costgrid/db";
import type { Alerter } from "./alerts.js";

/**
 * Judging trials, switching agents to models that passed, and switching them
 * back when results get worse (v3, phase 5, D14).
 *
 *   - A running trial is judged (trials.ts). A failed one stops; a passed one
 *     waits for the owner's approval, unless the agent may switch on its own:
 *     it has had a trial applied before, its owner set it to switch on its own,
 *     and it has quality evidence beyond inference.
 *   - Applying a trial writes a route rule for that agent, from the model it
 *     used to the candidate, so the switch sits in the rule register and the
 *     audit log like any other rule.
 *   - An applied switch is watched against its trial's baseline. If jobs
 *     finish less often, quality falls, failed calls rise or a good job costs
 *     more, the rule is switched off and an alert says why.
 */

export interface TrialReviewDeps {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly alerter?: Alerter | undefined;
}

/** Calls a switch must have made before it is judged on anything but errors. */
export const MIN_SWITCH_JOBS = 30;
/** How far a switched agent may fall below its trial's baseline, in points. */
export const SWITCH_TOLERANCE = 0.05;

const TRIALS_ACTOR: AuditActor = { kind: "autopilot", id: "trials", label: "CostGrid trials" };

/** Turn a passed trial into a route rule. Returns the rule's id. */
export function applyTrial(deps: TrialReviewDeps, tenantId: string, trial: Trial, by: AuditActor, now = Date.now()): string {
  const repository = new CostGridRepository(deps.db);
  const policyId = repository.createPolicy(
    tenantId,
    {
      name: `${trial.agentId}: ${trial.candidateModel} (trial ${trial.id})`,
      scope: { kind: "agent", agentId: trial.agentId },
      rule: { kind: "route", from: [trial.baselineModel], toModel: trial.candidateModel },
      action: "warn",
      enabled: true,
      owner: by.label,
      reason: `Trial ${trial.id} passed: ${trial.why ?? "as good and cheaper per good job"}`,
    },
    now,
  );
  new TrialsRepository(deps.db).setStatus(tenantId, trial.id, "applied", trial.why ?? "applied", now, policyId);
  deps.audit.record(
    tenantId,
    {
      actor: by,
      action: "switch.applied",
      subject: trial.agentId,
      detail: { trial: trial.id, from: trial.baselineModel, to: trial.candidateModel, rule: policyId },
    },
    now,
  );
  return policyId;
}

/** Review every organisation's trials and switches. Returns what changed, for the log. */
export function reviewTrials(deps: TrialReviewDeps, now = Date.now(), opts: { errorsOnly?: boolean } = {}): string[] {
  const trials = new TrialsRepository(deps.db);
  const repository = new CostGridRepository(deps.db);
  const changed: string[] = [];

  for (const trial of trials.allWithStatus("running")) {
    const { tenantId } = trial;
    const verdict = trials.judge(tenantId, trial);
    if (verdict.status === "running" || (opts.errorsOnly && !verdict.why.includes("failed"))) continue;
    trials.setStatus(tenantId, trial.id, verdict.status, verdict.why, now);
    deps.audit.record(tenantId, { actor: SYSTEM_ACTOR, action: `trial.${verdict.status}`, subject: trial.id, detail: { agent: trial.agentId, why: verdict.why } }, now);
    deps.alerter?.raise(
      tenantId,
      {
        kind: "switched-back",
        dedupeKey: `trial:${trial.id}:${verdict.status}`,
        subject: trial.agentId,
        message:
          verdict.status === "passed"
            ? `The test of ${trial.candidateModel} for ${trial.agentId} passed: ${verdict.why}. You can switch it on the Tests screen.`
            : `The test of ${trial.candidateModel} for ${trial.agentId} stopped: ${verdict.why}. All its jobs go to ${trial.baselineModel} again.`,
      },
      now,
    );
    changed.push(`${trial.id}:${verdict.status}`);

    if (
      verdict.status === "passed" &&
      trials.agentSettings(tenantId, trial.agentId).switching === "auto" &&
      trials.hasApplied(tenantId, trial.agentId) &&
      trials.hasQualitySignals(tenantId, trial)
    ) {
      applyTrial(deps, tenantId, { ...trial, status: "passed", why: verdict.why }, TRIALS_ACTOR, now);
      changed.push(`${trial.id}:applied`);
    }
  }

  for (const trial of trials.allWithStatus("applied")) {
    const { tenantId } = trial;
    const after = trials.switchStats(tenantId, trial);
    const before = trials.armStats(tenantId, trial, "baseline");
    const pct = (x: number | null) => `${Math.round((x ?? 0) * 100)}%`;
    let why: string | undefined;
    if (after.errors >= 5 && (after.errorRate ?? 0) >= (before.errorRate ?? 0) + SWITCH_TOLERANCE) {
      why = `${after.errors} calls failed since the switch (${pct(after.errorRate)} against ${pct(before.errorRate)})`;
    } else if (!opts.errorsOnly && after.jobs >= MIN_SWITCH_JOBS) {
      if ((after.finishedShare ?? 0) < (before.finishedShare ?? 0) - SWITCH_TOLERANCE) {
        why = `fewer jobs finished: ${pct(after.finishedShare)} against ${pct(before.finishedShare)} before`;
      } else if (after.qualityShare !== null && before.qualityShare !== null && after.qualityShare < before.qualityShare - SWITCH_TOLERANCE) {
        why = `quality fell: ${pct(after.qualityShare)} up to standard against ${pct(before.qualityShare)}`;
      } else if (after.costPerGoodJob !== null && before.costPerGoodJob !== null && after.costPerGoodJob > before.costPerGoodJob) {
        why = "a good job now costs more than it did on the old model";
      }
    }
    if (why === undefined) continue;

    if (trial.policyId !== null) repository.setPolicyEnabled(trial.policyId, false, now);
    trials.setStatus(tenantId, trial.id, "reverted", why, now);
    deps.audit.record(
      tenantId,
      { actor: SYSTEM_ACTOR, action: "switch.reverted", subject: trial.agentId, detail: { trial: trial.id, rule: trial.policyId, why } },
      now,
    );
    deps.alerter?.raise(
      tenantId,
      {
        kind: "switched-back",
        dedupeKey: `switch:${trial.id}:reverted`,
        subject: trial.agentId,
        message: `${trial.agentId} is back on ${trial.baselineModel}, because ${why}. The switch is off, and kept in your list of rules.`,
      },
      now,
    );
    changed.push(`${trial.id}:reverted`);
  }
  return changed;
}
