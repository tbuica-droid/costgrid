import { type BodyFormat, isReasoningEffort, oneLevelBelow, type ReasoningEffort } from "@costgrid/core";
import type { Proposal } from "./advise.js";
import type { TimeRange } from "./analytics.js";
import type { Db } from "./database.js";
import { Insights } from "./insights.js";

/**
 * Suggest lowering reasoning for agents that think at length to say little.
 *
 * Built on the overthinking signal (`insights.ts`): short visible answers after
 * at least four times as much reasoning. The suggestion is one level below the
 * effort the agent most often asks for, installed as a dry run, and only for an
 * agent whose requests name an effort, since a rule cannot lower what a request
 * never set. No saving is quoted: how much less a lower level reasons on this
 * agent's work is what the measurement after switching it on will say.
 */

const MIN_OVERTHINKING_CALLS = 20;
/** $5 of reasoning over the window. */
const MIN_REASONING_COST = 5_000_000_000n;

export function lowerReasoningProposals(db: Db, tenantId: string, range: TimeRange): Proposal[] {
  const { overthinking } = new Insights(db).reasoning(tenantId, range);
  const out: Proposal[] = [];

  for (const signal of overthinking) {
    if (signal.calls < MIN_OVERTHINKING_CALLS || signal.reasoningCost < MIN_REASONING_COST) continue;

    const asked = db
      .prepare(
        `SELECT reasoning_requested AS requested, provider, COUNT(*) AS calls
         FROM calls
         WHERE tenant_id = ? AND agent_id = ? AND outcome = 'ok' AND reasoning_requested LIKE 'effort:%'
           AND started_at >= ? AND started_at < ?
         GROUP BY reasoning_requested, provider
         ORDER BY calls DESC LIMIT 1`,
      )
      .get(tenantId, signal.agentId, range.from, range.to) as
      | { requested: string; provider: string; calls: number }
      | undefined;
    if (asked === undefined) continue;

    const effort = asked.requested.split(" ")[0]!.slice("effort:".length);
    if (!isReasoningEffort(effort)) continue;
    const format: BodyFormat = asked.provider === "openai" ? "openai" : "anthropic";
    const target: ReasoningEffort | undefined = oneLevelBelow(effort, format);
    if (target === undefined) continue;

    const dollars = (Number(signal.reasoningCost) / 1e9).toFixed(2);
    out.push({
      kind: "lower-reasoning",
      intent: "finding",
      headline: `${signal.agentId} thinks at length for short answers: try effort ${target}`,
      evidence:
        `${signal.calls} call(s) gave a short answer (under 200 tokens) after at least four times as much ` +
        `reasoning, $${dollars} of reasoning in all. Most of its calls ask for effort ${effort}. ` +
        "Turned down one level, it is measured on cost per finished job and switched back on its own " +
        "if it costs more or fewer jobs finish.",
      rule: { kind: "lower-reasoning", effort: target },
      scope: { kind: "agent", agentId: signal.agentId },
      backtest: undefined,
      weight: signal.reasoningCost,
      command: `costgrid policy lower-reasoning agent:${signal.agentId} --effort ${target} --action monitor`,
    });
  }
  return out;
}
