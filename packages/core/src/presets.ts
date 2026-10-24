/**
 * What a workflow is for, in words an owner would use.
 *
 * Each preset says what counts as a finished job, because cost per finished
 * job is the number an owner actually wants and "finished" means something
 * different for a support ticket than for a sales lead. It also says how much
 * to trust that signal and how long to wait before calling a job finished: a
 * ticket can be reopened for a week, a saved record is corrected within a day
 * or not at all.
 *
 * Versioned, so a source named under one definition keeps that definition if
 * the wording or window changes later. Bump `version` whenever a preset's
 * meaning changes, not for a typo.
 */

/** How well the finished-job signal tracks real value. */
export type EvidenceStrength = "strong" | "medium" | "weak";

export interface PurposePreset {
  readonly id: "support" | "sales-leads" | "content" | "data-entry" | "other";
  readonly version: string;
  readonly label: string;
  /** One sentence: what counts as a finished job. */
  readonly finishedJob: string;
  readonly evidence: EvidenceStrength;
  /** How long after the work a job can still turn out not to be finished. */
  readonly maturationWindowMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const PURPOSE_PRESETS: readonly PurposePreset[] = [
  {
    id: "support",
    version: "1",
    label: "Customer support",
    finishedJob: "A ticket is closed and not reopened",
    evidence: "strong",
    maturationWindowMs: 7 * DAY_MS,
  },
  {
    id: "sales-leads",
    version: "1",
    label: "Sales leads",
    finishedJob: "A lead is qualified or a meeting is booked",
    evidence: "medium",
    maturationWindowMs: 14 * DAY_MS,
  },
  {
    id: "content",
    version: "1",
    label: "Content",
    finishedJob: "A piece is approved or published without a major rewrite",
    evidence: "medium",
    maturationWindowMs: 3 * DAY_MS,
  },
  {
    id: "data-entry",
    version: "1",
    label: "Data entry",
    finishedJob: "A record is saved and not corrected later",
    evidence: "strong",
    maturationWindowMs: 1 * DAY_MS,
  },
  {
    id: "other",
    version: "1",
    label: "Other",
    finishedJob: "You'll define what a finished job is later",
    evidence: "weak",
    maturationWindowMs: 7 * DAY_MS,
  },
];

export function presetFor(id: string): PurposePreset | undefined {
  return PURPOSE_PRESETS.find((preset) => preset.id === id);
}
