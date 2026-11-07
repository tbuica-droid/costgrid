import { listModelPrices, type WireFormat } from "@costgrid/core";
import type { Arm, TrialsRepository } from "@costgrid/db";

/**
 * Side-by-side grading for trials (v3, D10 and D11): opt-in, on a small
 * sample, after the caller already has its answer.
 *
 * For a sampled job, the same request goes to the other arm's model, and a
 * stronger model from a provider the customer already uses is asked which
 * answer is better, with the order shuffled so position cannot decide it.
 * Only the verdict is stored. Both extra calls are recorded as the agent's
 * grading calls, so what grading costs shows in the agent's costs.
 *
 * The answers themselves are held in memory only (`SpotCheckMemory`), and
 * only while the organisation has spot checks on: at most 50, for 24 hours
 * or until a restart, so the owner can read a pair when checking the grader.
 * They are never written to disk (owner decision, 7 November 2026).
 */

export type CallModel = (model: string, format: WireFormat, body: unknown) => Promise<string | undefined>;

/** Seen before an answer is cut: the grader reads at most this much of each. */
const EXCERPT = 6_000;

/** The strongest model of a provider the customer uses: its frontier model with the highest output price. */
export function graderFor(format: WireFormat): string | undefined {
  const provider = format === "openai" ? "openai" : "anthropic";
  const frontier = listModelPrices(provider).filter((m) => m.tier === "frontier" && !m.retired);
  frontier.sort((a, b) => (b.output > a.output ? 1 : b.output < a.output ? -1 : 0));
  return frontier[0]?.id;
}

function graderRequest(format: WireFormat, model: string, task: string, first: string, second: string): unknown {
  const prompt =
    "You are grading two answers to the same request. Judge only which answer does the job better: correct, " +
    "complete and appropriate. Length is not quality.\n\n" +
    `<request>\n${task.slice(0, EXCERPT)}\n</request>\n\n<answer_a>\n${first.slice(0, EXCERPT)}\n</answer_a>\n\n` +
    `<answer_b>\n${second.slice(0, EXCERPT)}\n</answer_b>\n\nReply with exactly one word: A, B or TIE.`;
  return format === "openai"
    ? { model, max_completion_tokens: 2_000, messages: [{ role: "user", content: prompt }] }
    : { model, max_tokens: 10, messages: [{ role: "user", content: prompt }] };
}

/** "A", "B" or "TIE" from the grader's reply; anything else is no verdict. */
export function readVerdict(reply: string): "A" | "B" | "TIE" | undefined {
  const word = reply.trim().toUpperCase().replace(/[^A-Z]/g, " ").trim().split(/\s+/)[0];
  return word === "A" || word === "B" || word === "TIE" ? word : undefined;
}

export interface Pair {
  readonly trialId: string;
  readonly runId: string;
  readonly task: string;
  readonly candidate: string;
  readonly baseline: string;
  readonly verdict: Arm | "tie";
  readonly at: number;
}

const KEEP = 50;
const TTL_MS = 24 * 60 * 60 * 1000;

/** Graded pairs in memory only, for the owner's spot checks. Never written to disk. */
export class SpotCheckMemory {
  readonly #byTenant = new Map<string, Map<string, Pair>>();

  put(tenantId: string, callId: string, pair: Pair): void {
    const pairs = this.#byTenant.get(tenantId) ?? new Map<string, Pair>();
    pairs.set(callId, pair);
    while (pairs.size > KEEP) pairs.delete(pairs.keys().next().value!);
    this.#byTenant.set(tenantId, pairs);
  }

  get(tenantId: string, callId: string, now = Date.now()): Pair | undefined {
    const pair = this.#byTenant.get(tenantId)?.get(callId);
    if (pair === undefined || now - pair.at > TTL_MS) return undefined;
    return pair;
  }

  forget(tenantId: string, callId: string): void {
    this.#byTenant.get(tenantId)?.delete(callId);
  }

  /** Drop everything held for an organisation, when it turns spot checks off. */
  forgetAll(tenantId: string): void {
    this.#byTenant.delete(tenantId);
  }
}

/**
 * Grade one job. Never throws: grading is a measurement, and a failed one
 * just means one fewer verdict.
 */
export async function gradeJob(
  g: {
    tenantId: string;
    trialId: string;
    callId: string;
    runId: string;
    arm: Arm;
    format: WireFormat;
    request: unknown;
    task: string;
    answer: string;
    otherModel: string;
  },
  deps: { call: CallModel; trials: TrialsRepository; memory: SpotCheckMemory; holdAnswers: boolean; random?: () => number },
): Promise<Arm | "tie" | undefined> {
  const grader = graderFor(g.format);
  if (grader === undefined) return undefined;
  const other = await deps.call(g.otherModel, g.format, g.request);
  if (other === undefined) return undefined;

  const candidate = g.arm === "candidate" ? g.answer : other;
  const baseline = g.arm === "candidate" ? other : g.answer;
  // Shuffled, so a grader that favours the first answer cannot favour an arm.
  const candidateFirst = (deps.random ?? Math.random)() < 0.5;
  const [a, b] = candidateFirst ? [candidate, baseline] : [baseline, candidate];
  const reply = await deps.call(grader, g.format, graderRequest(g.format, grader, g.task, a, b));
  const said = reply === undefined ? undefined : readVerdict(reply);
  if (said === undefined) return undefined;

  const verdict: Arm | "tie" = said === "TIE" ? "tie" : (said === "A") === candidateFirst ? "candidate" : "baseline";
  deps.trials.recordGrade(g.tenantId, { trialId: g.trialId, callId: g.callId, runId: g.runId, verdict, graderModel: grader });
  // Held for the owner to read only while spot checks are on.
  if (deps.holdAnswers) {
    deps.memory.put(g.tenantId, g.callId, { trialId: g.trialId, runId: g.runId, task: g.task, candidate, baseline, verdict, at: Date.now() });
  }
  return verdict;
}
