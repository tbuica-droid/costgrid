import type { LcsoResult } from "./lcso-types.js";
import { compareRatio, ratio, type Ratio } from "./ratio.js";

/**
 * The one-sentence verdict per agent on the results screen, chosen from an
 * LCSO result by fixed rules so the same figures always give the same words.
 *
 * Kinds, first match wins:
 *   - `no-data`: nothing resolved and nothing waiting, or nothing spent.
 *   - `spend-no-successes`: money was spent and no job finished (the engine's flag).
 *   - `too-early`: jobs are waiting out their window; none resolved yet.
 *   - `dearer-than-person`: a finished job costs at least the person estimate.
 *   - `mostly-failures`: at least half the spend went on jobs that didn't finish.
 *   - `unpredictable`: a bad job (p90) costs at least 3× a typical one (p50).
 *   - `steady`: none of the above.
 *
 * Only `kind` decides the wording; the screen writes the sentence, and
 * labels every figure in it as indicative.
 */

export const VERDICT_KINDS = [
  "no-data",
  "spend-no-successes",
  "too-early",
  "dearer-than-person",
  "mostly-failures",
  "unpredictable",
  "steady",
] as const;
export type VerdictKind = (typeof VERDICT_KINDS)[number];

/** A bad job costing this many times a typical one counts as unpredictable. */
export const UNPREDICTABLE_SPREAD = 3n;

const HALF = ratio(1n, 2n);

export function verdictOf(result: LcsoResult): VerdictKind {
  if (result.flags.includes("spend-but-no-successes")) return "spend-no-successes";
  if (result.counts.resolved === 0) return result.counts.pending > 0 ? "too-early" : "no-data";
  const { model, tools, human, fixed } = result.components;
  // Nothing spent on resolved jobs: a provider report not imported yet, say. Nothing to divide.
  if (model + tools + human.total + fixed.total === 0n) return "no-data";
  if (result.her.reported && compareRatio(result.her.value.ratio, ratio(1n, 1n)) >= 0) return "dearer-than-person";
  if (result.failureCostShare.reported && compareRatio(result.failureCostShare.value, HALF) >= 0) {
    return "mostly-failures";
  }
  if (result.spread.reported && result.spread.value.spreadRatio.reported) {
    const spread: Ratio = result.spread.value.spreadRatio.value;
    if (compareRatio(spread, ratio(UNPREDICTABLE_SPREAD, 1n)) >= 0) return "unpredictable";
  }
  return "steady";
}
