import { type Nanodollars, toUsdString } from "@costgrid/core";
import { Advisor } from "./advise.js";
import { Analytics, type TimeRange } from "./analytics.js";
import type { Db } from "./database.js";

/**
 * The facts an analyst is allowed to reason from.
 *
 * Built here, deliberately, rather than letting anything query the database
 * freely. Two reasons, and both matter more than the convenience lost.
 *
 * The first is confidentiality. This is the only thing that leaves a
 * customer's network, so it has to be something they can read in full and
 * approve. It is numbers, names they chose, and nothing else. CostGrid never
 * stores a prompt, a completion or a tool argument, so none can appear here,
 * but "we could not send it if we tried" is a better answer to a security
 * reviewer than "we would not".
 *
 * The second is grounding. A model given a fixed set of figures can be checked
 * against them afterwards. A model given a database cannot.
 *
 * `render()` produces the exact bytes sent. The inspection command prints the
 * same string, so what a customer reviews is what goes out, not a summary of
 * it written separately and free to drift.
 */

export interface Briefing {
  readonly windowDays: number;
  readonly totalSpend: Nanodollars;
  readonly previousSpend: Nanodollars;
  readonly calls: number;
  readonly blockedCalls: number;
  readonly erroredCalls: number;
  readonly byDay: readonly { day: string; cost: Nanodollars; calls: number }[];
  readonly byAgent: readonly { key: string; cost: Nanodollars; calls: number }[];
  readonly byDepartment: readonly { key: string; cost: Nanodollars; calls: number }[];
  readonly byModel: readonly { key: string; cost: Nanodollars; calls: number }[];
  readonly movers: readonly { key: string; now: Nanodollars; before: Nanodollars }[];
  readonly violations: readonly { when: string; action: string; agent: string; reason: string }[];
  readonly proposals: readonly { headline: string; evidence: string }[];
  readonly runCoverage: { declared: number; total: number };
}

/** Caps, so a large fleet cannot turn one question into an enormous request. */
const MAX_ROWS = 15;
const MAX_VIOLATIONS = 12;
const MAX_PROPOSALS = 6;

function usd(nano: Nanodollars): string {
  return `$${toUsdString(nano, 2)}`;
}

export class Briefings {
  readonly #analytics: Analytics;
  readonly #advisor: Advisor;

  constructor(db: Db) {
    this.#analytics = new Analytics(db);
    this.#advisor = new Advisor(db);
  }

  build(tenantId: string, range: TimeRange, windowDays: number): Briefing {
    const span = range.to - range.from;
    const previous: TimeRange = { from: range.from - span, to: range.from };

    const summary = this.#analytics.summary(tenantId, range);
    const before = this.#analytics.summary(tenantId, previous);

    const agentsNow = this.#analytics.spendByAgent(tenantId, range);
    const agentsBefore = new Map(
      this.#analytics.spendByAgent(tenantId, previous).map((r) => [r.key, r.cost]),
    );

    /*
     * Movers, because "what changed" is the question people actually ask and
     * it is not answerable from one window. Sorted by absolute change so a
     * collapse is as visible as a spike.
     */
    const movers = agentsNow
      .map((row) => ({ key: row.key, now: row.cost, before: agentsBefore.get(row.key) ?? 0n }))
      .sort((a, b) => {
        const da = a.now - a.before < 0n ? a.before - a.now : a.now - a.before;
        const db = b.now - b.before < 0n ? b.before - b.now : b.now - b.before;
        return db > da ? 1 : db < da ? -1 : 0;
      })
      .slice(0, MAX_ROWS);

    return {
      windowDays,
      totalSpend: summary.totalCost,
      previousSpend: before.totalCost,
      calls: summary.calls,
      blockedCalls: summary.blockedCalls,
      erroredCalls: summary.erroredCalls,
      byDay: this.#analytics
        .dailySpend(tenantId, range)
        .map((b) => ({ day: b.day, cost: b.cost, calls: b.calls })),
      byAgent: agentsNow.slice(0, MAX_ROWS),
      byDepartment: this.#analytics.spendByDepartment(tenantId, range).slice(0, MAX_ROWS),
      byModel: this.#analytics.spendByModel(tenantId, range).slice(0, MAX_ROWS),
      movers,
      violations: this.#analytics.recentViolations(tenantId, MAX_VIOLATIONS).map((v) => ({
        when: new Date(v.occurredAt).toISOString().slice(0, 16).replace("T", " "),
        action: v.action,
        agent: v.agentId ?? "unknown",
        reason: v.reason,
      })),
      proposals: this.#advisor
        .proposals(tenantId, range)
        .slice(0, MAX_PROPOSALS)
        .map((p) => ({ headline: p.headline, evidence: p.evidence })),
      runCoverage: this.#analytics.runCoverage(tenantId, range),
    };
  }
}

/**
 * The briefing as the bytes that are actually sent.
 *
 * Plain text rather than JSON because a customer has to be able to read it at
 * a glance and decide whether they are comfortable, and because the question
 * being asked of it is written in the same register.
 */
export function render(b: Briefing): string {
  const lines: string[] = [];
  const table = (title: string, rows: readonly { key: string; cost: Nanodollars; calls: number }[]) => {
    if (rows.length === 0) return;
    lines.push(`${title}:`);
    for (const row of rows) lines.push(`  ${row.key}: ${usd(row.cost)} over ${row.calls} calls`);
  };

  lines.push(`Window: the last ${b.windowDays} days.`);
  lines.push(`Total spend: ${usd(b.totalSpend)}. The ${b.windowDays} days before that: ${usd(b.previousSpend)}.`);
  lines.push(
    `Calls: ${b.calls} total, ${b.blockedCalls} blocked by a rule, ${b.erroredCalls} failed.`,
  );
  lines.push("");

  if (b.byDay.length > 0) {
    lines.push("Spend per day:");
    for (const day of b.byDay) lines.push(`  ${day.day}: ${usd(day.cost)} over ${day.calls} calls`);
    lines.push("");
  }

  table("Spend by agent", b.byAgent);
  lines.push("");
  table("Spend by department", b.byDepartment);
  lines.push("");
  table("Spend by model", b.byModel);
  lines.push("");

  if (b.movers.length > 0) {
    lines.push("Change per agent against the previous window:");
    for (const m of b.movers) {
      lines.push(`  ${m.key}: ${usd(m.before)} before, ${usd(m.now)} now`);
    }
    lines.push("");
  }

  if (b.violations.length > 0) {
    lines.push("Recent policy events:");
    for (const v of b.violations) lines.push(`  ${v.when} ${v.action} ${v.agent}: ${v.reason}`);
    lines.push("");
  }

  if (b.proposals.length > 0) {
    lines.push("Things CostGrid already noticed:");
    for (const p of b.proposals) lines.push(`  ${p.headline}. ${p.evidence}`);
    lines.push("");
  }

  lines.push(
    `Run tracking: ${b.runCoverage.declared} of ${b.runCoverage.total} calls carried a run id.`,
  );
  return lines.join("\n");
}
