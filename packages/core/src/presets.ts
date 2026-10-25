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
 * Versioned, so an agent set up under one definition keeps that definition if
 * the wording or windows change later. A changed meaning is a new version
 * beside the old one, never an edit to it: figures under different versions
 * must not be compared (method §5.2).
 *
 * Version 1 described the finished job in the owner's terms. Version 2
 * describes what CostGrid can see in its own traffic, for automatic detection
 * (`outcome-detect.ts`), and rates its evidence for that: behaviour is a
 * weaker witness than a helpdesk record.
 */

/** How well the finished-job signal tracks real value. */
export type EvidenceStrength = "strong" | "medium" | "weak";

export type PurposeId = "support" | "sales-leads" | "content" | "data-entry" | "other";

export interface PurposePreset {
  readonly id: PurposeId;
  readonly version: string;
  readonly label: string;
  /** One sentence: what counts as a finished job. */
  readonly finishedJob: string;
  readonly evidence: EvidenceStrength;
  /** How long after the work a job can still turn out not to be finished. */
  readonly maturationWindowMs: number;
  /**
   * How soon a job asked again means the earlier attempt did not finish.
   * Absent before version 2, which is what "no automatic detection" means.
   */
  readonly reRunWindowMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const LABELS: Readonly<Record<PurposeId, string>> = {
  support: "Customer support",
  "sales-leads": "Sales leads",
  content: "Content",
  "data-entry": "Data entry",
  other: "Other",
};

const MATURATION: Readonly<Record<PurposeId, number>> = {
  support: 7 * DAY_MS,
  "sales-leads": 14 * DAY_MS,
  content: 3 * DAY_MS,
  "data-entry": 1 * DAY_MS,
  other: 7 * DAY_MS,
};

const v1 = (id: PurposeId, finishedJob: string, evidence: EvidenceStrength): PurposePreset => ({
  id,
  version: "1",
  label: LABELS[id],
  finishedJob,
  evidence,
  maturationWindowMs: MATURATION[id],
});

const v2 = (id: PurposeId, finishedJob: string, evidence: EvidenceStrength, reRunWindowMs: number): PurposePreset => ({
  id,
  version: "2",
  label: LABELS[id],
  finishedJob,
  evidence,
  maturationWindowMs: MATURATION[id],
  reRunWindowMs,
});

/** Every version ever published, oldest first. Never edit an entry; add a version. */
export const PRESET_HISTORY: readonly PurposePreset[] = [
  v1("support", "A ticket is closed and not reopened", "strong"),
  v1("sales-leads", "A lead is qualified or a meeting is booked", "medium"),
  v1("content", "A piece is approved or published without a major rewrite", "medium"),
  v1("data-entry", "A record is saved and not corrected later", "strong"),
  v1("other", "You'll define what a finished job is later", "weak"),
  v2(
    "support",
    "The conversation ends without going to a person, and the same question isn't asked again within a day",
    "medium",
    24 * HOUR_MS,
  ),
  v2(
    "sales-leads",
    "The lead is handled without going to a person, and isn't picked up again within two days",
    "weak",
    48 * HOUR_MS,
  ),
  v2("content", "A draft is produced without errors, and isn't asked for again within a day", "medium", 24 * HOUR_MS),
  v2("data-entry", "A record is processed without errors, and isn't redone within two hours", "medium", 2 * HOUR_MS),
  v2("other", "The job ends normally, and isn't asked for again within a day", "weak", 24 * HOUR_MS),
];

export const LATEST_PRESET_VERSION = "2";

/** The presets an owner picks from today: the latest version of each, in order. */
export const PURPOSE_PRESETS: readonly PurposePreset[] = PRESET_HISTORY.filter(
  (preset) => preset.version === LATEST_PRESET_VERSION,
);

/** A preset by id, at a given version or the latest. Undefined for an unknown id or version. */
export function presetFor(id: string, version: string = LATEST_PRESET_VERSION): PurposePreset | undefined {
  return PRESET_HISTORY.find((preset) => preset.id === id && preset.version === version);
}
