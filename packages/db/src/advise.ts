import {
  type Nanodollars,
  type PolicyRule,
  type PolicyScope,
  type Provider,
  findModelPrice,
  listModelPrices,
  substitutionAllowed,
} from "@costgrid/core";
import type { Db } from "./database.js";
import type { TimeRange } from "./analytics.js";
import { Backtester, type BacktestResult } from "./backtest.js";

/**
 * Proposals drawn from a fleet's own metered traffic.
 *
 * This is the layer that watches and suggests, and the line it does not cross
 * is the point of it: **it proposes, the deterministic engine enforces**. Every
 * proposal is a concrete `PolicyRule`, replayed against the calls that already
 * happened, and handed back with the exact command that would create it. A
 * human decides. Nothing here writes a policy, and nothing here is in the
 * request path.
 *
 * That boundary is not timidity. The product's credibility rests on measuring
 * rather than estimating; an advisory layer that could act would put a
 * judgement call between a customer and their invoice. Being wrong here costs
 * a rejected suggestion. Being wrong there costs a bill that will not
 * reconcile, and no customer forgives that twice.
 */

export type ProposalKind =
  | "route-to-cheaper"
  | "unguarded-spend"
  | "truncation-waste"
  | "unused-capability"
  | "long-run"
  | "no-run-context";

/**
 * What a proposal is *for*, which decides how it ranks and how it reads.
 *
 * Mixing these in one list was the first version and it was wrong: ordering
 * everything by "money involved" put two proposals that save nothing above a
 * route rule worth real money, under a heading that promised the opposite. A
 * cap that would never have fired is a *correctly sized* cap; a route rule that
 * would never have fired is a waste of the reader's attention. Same sentence,
 * opposite meanings, so they cannot share a ranking.
 */
export type ProposalIntent =
  /** Moves money now. Ranked by how much. */
  | "saving"
  /** Bounds a risk and saves nothing today. Ranked by what is exposed. */
  | "guardrail"
  /** No rule to write — something to know. */
  | "finding";

export interface Proposal {
  readonly kind: ProposalKind;
  readonly intent: ProposalIntent;
  /** One line a person can act on, in their words rather than the schema's. */
  readonly headline: string;
  /** What in the traffic prompted this, stated as fact. */
  readonly evidence: string;
  /** The rule being proposed, or `undefined` for a finding with no rule to write. */
  readonly rule: PolicyRule | undefined;
  readonly scope: PolicyScope;
  /** Replay of that rule against the same window. */
  readonly backtest: BacktestResult | undefined;
  /**
   * Ranking figure in nanodollars, within this proposal's own intent: the
   * saving for a `saving`, the exposure for a `guardrail` or `finding`. Never
   * compared across intents. Not a promise; see each backtest's caveat.
   */
  readonly weight: Nanodollars;
  /** Ready to paste. Nothing here runs it. */
  readonly command: string | undefined;
}

/**
 * Thresholds, gathered here rather than scattered through the detectors.
 *
 * Every one of these is a judgement about what is worth a customer's
 * attention, not a fact about their fleet. They are deliberately conservative:
 * a list of twelve proposals worth $3 each trains someone to ignore the list.
 */
const MIN_SPEND_TO_MENTION = 10_000_000_000n; // $10 over the window
const MIN_CALLS_TO_GENERALISE = 20;
const SHORT_OUTPUT_TOKENS = 600;
const TRUNCATION_RATE_TO_FLAG = 0.05;
/**
 * Steps past which a run is worth a second look.
 *
 * There is no way to tell a loop from long legitimate work by counting calls,
 * so this is a threshold for *attention*, not a verdict, and the proposal says
 * so. An earlier version of this detector flagged bursts of calls per minute;
 * it was dropped because a high call rate is just throughput, and a check that
 * fires on every busy service is a check nobody reads.
 */
const LONG_RUN_STEPS = 25;
/** Below this, a fleet has not shown enough traffic for run coverage to mean anything. */
const MIN_CALLS_FOR_COVERAGE_ADVICE = 200;

interface AgentModelRow {
  agentId: string;
  department: string;
  model: string;
  calls: bigint;
  cost: bigint;
  outputTokens: bigint;
  truncated: bigint;
}

export class Advisor {
  readonly #db: Db;
  readonly #backtester: Backtester;

  constructor(db: Db) {
    this.#db = db;
    this.#backtester = new Backtester(db);
  }

  /**
   * Every proposal worth showing, most money first.
   *
   * Ordering by money rather than by confidence is deliberate: the caveats
   * travel with each proposal, and a customer is better served by seeing the
   * $400 suggestion they must think about above the $12 one they can take on
   * trust.
   */
  proposals(tenantId: string, range: TimeRange): Proposal[] {
    const found = [
      ...this.#routeCandidates(tenantId, range),
      ...this.#unguardedSpend(tenantId, range),
      ...this.#truncationWaste(tenantId, range),
      ...this.#unusedCapability(tenantId, range),
      ...this.#longRuns(tenantId, range),
      ...this.#noRunContext(tenantId, range),
    ];

    const order: Record<ProposalIntent, number> = { saving: 0, guardrail: 1, finding: 2 };
    return found.sort((a, b) => {
      if (order[a.intent] !== order[b.intent]) return order[a.intent] - order[b.intent];
      return b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : 0;
    });
  }

  // ------------------------------------------------------- route to cheaper

  /**
   * Agents doing short work on an expensive model.
   *
   * Short output is the only signal available from metered rows that
   * correlates with a task a smaller model could have done — and it is a weak
   * one, which is why the proposal says `--action monitor` and why the
   * backtest that follows is the actual argument.
   */
  #routeCandidates(tenantId: string, range: TimeRange): Proposal[] {
    const rows = this.#db
      .prepare(
        `SELECT agent_id AS agentId, department, model,
                COUNT(*) AS calls, SUM(cost_total) AS cost,
                SUM(output_tokens) AS outputTokens,
                SUM(CASE WHEN stop_reason = 'max_tokens' THEN 1 ELSE 0 END) AS truncated
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND priced = 1
           AND started_at >= ? AND started_at < ?
         GROUP BY agent_id, model
         HAVING calls >= ?`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to, MIN_CALLS_TO_GENERALISE) as unknown as AgentModelRow[];

    const out: Proposal[] = [];
    for (const row of rows) {
      if (row.cost < MIN_SPEND_TO_MENTION) continue;

      const price = findModelPrice(row.model);
      if (!price || (price.tier !== "frontier" && price.tier !== "mid")) continue;

      const meanOutput = Number(row.outputTokens) / Number(row.calls);
      if (meanOutput > SHORT_OUTPUT_TOKENS) continue;

      const target = cheapestSameProvider(price.provider, row.model);
      if (target === undefined) continue;

      const scope: PolicyScope = { kind: "agent", agentId: row.agentId };
      const rule: PolicyRule = { kind: "route", from: [row.model], toModel: target };
      const backtest = this.#backtester.run(tenantId, scope, rule, range);
      if (backtest.amount === undefined || backtest.amount <= 0n) continue;

      out.push({
        kind: "route-to-cheaper",
        intent: "saving",
        headline: `${row.agentId} could run ${row.model} work on ${target}`,
        evidence:
          `${row.calls} call(s) averaging ${Math.round(meanOutput)} output tokens. ` +
          "Short answers, on one of the most expensive models you run.",
        rule,
        scope,
        backtest,
        weight: backtest.amount,
        command:
          `costgrid policy route agent:${row.agentId} ${target} ` +
          `--from ${row.model} --action monitor`,
      });
    }
    return out;
  }

  // -------------------------------------------------------- unguarded spend

  /** Departments spending real money with no budget rule of any kind. */
  #unguardedSpend(tenantId: string, range: TimeRange): Proposal[] {
    const guarded = new Set(
      (
        this.#db
          .prepare(
            `SELECT scope_value AS scopeValue FROM policies
             WHERE tenant_id = ? AND enabled = 1 AND scope_kind = 'department'
               AND rule_json LIKE '%"budget"%'`,
          )
          .all(tenantId) as { scopeValue: string | null }[]
      ).map((r) => r.scopeValue ?? ""),
    );

    const tenantWide = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM policies
         WHERE tenant_id = ? AND enabled = 1 AND scope_kind = 'tenant'
           AND rule_json LIKE '%"budget"%'`,
      )
      .get(tenantId) as { n: number };
    // A tenant-wide budget covers everyone; proposing per-department caps on
    // top of it would be noise rather than a finding.
    if (tenantWide.n > 0) return [];

    const rows = this.#db
      .prepare(
        `SELECT department, SUM(cost_total) AS cost, COUNT(*) AS calls
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
         GROUP BY department`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to) as unknown as {
      department: string;
      cost: bigint;
      calls: bigint;
    }[];

    const out: Proposal[] = [];
    for (const row of rows) {
      if (row.cost < MIN_SPEND_TO_MENTION) continue;
      if (guarded.has(row.department)) continue;

      /*
       * Proposed at roughly 1.5x observed spend, and deliberately not tighter.
       * A cap set at what a team already spends fires on their first normal
       * week, and a rule that cries wolf gets turned off rather than tuned.
       */
      const suggested = (row.cost * 3n) / 2n;
      const scope: PolicyScope = { kind: "department", department: row.department };
      const rule: PolicyRule = { kind: "budget", window: "month", limit: suggested };

      out.push({
        kind: "unguarded-spend",
        intent: "guardrail",
        headline: `${row.department} has no spending cap`,
        evidence: `${row.calls} call(s) over this window, and no budget rule covering them.`,
        rule,
        scope,
        backtest: this.#backtester.run(tenantId, scope, rule, range),
        // Ranked by what is unguarded, not by a saving — there is none to make.
        weight: row.cost,
        command:
          `costgrid policy budget dept:${row.department} ${usd(suggested)} ` +
          "--window month --action monitor",
      });
    }
    return out;
  }

  // ------------------------------------------------------ truncation waste

  /**
   * Answers cut off at `max_tokens`.
   *
   * This is the cleanest waste signal in the data and it has no rule to
   * propose: the fix is in the customer's own request, not in a policy. It is
   * reported anyway, because an answer that stopped mid-sentence was paid for
   * and thrown away, and nobody is watching `stop_reason`.
   */
  #truncationWaste(tenantId: string, range: TimeRange): Proposal[] {
    const rows = this.#db
      .prepare(
        `SELECT agent_id AS agentId, COUNT(*) AS calls,
                SUM(CASE WHEN stop_reason = 'max_tokens' THEN 1 ELSE 0 END) AS truncated,
                SUM(CASE WHEN stop_reason = 'max_tokens' THEN cost_total ELSE 0 END) AS wasted
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
         GROUP BY agent_id
         HAVING calls >= ?`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to, MIN_CALLS_TO_GENERALISE) as unknown as {
      agentId: string;
      calls: bigint;
      truncated: bigint;
      wasted: bigint;
    }[];

    const out: Proposal[] = [];
    for (const row of rows) {
      const rate = Number(row.truncated) / Number(row.calls);
      if (rate < TRUNCATION_RATE_TO_FLAG || row.wasted < MIN_SPEND_TO_MENTION) continue;

      out.push({
        kind: "truncation-waste",
        intent: "finding",
        headline: `${row.agentId} is paying for answers that get cut off`,
        evidence:
          `${row.truncated} of ${row.calls} call(s) (${(rate * 100).toFixed(0)}%) ended at ` +
          "max_tokens. A truncated answer is billed in full and is usually retried.",
        rule: undefined,
        scope: { kind: "agent", agentId: row.agentId },
        backtest: undefined,
        weight: row.wasted,
        // No rule to write: raising max_tokens, or shortening the prompt, is a
        // change in their code. Saying so beats inventing a policy for it.
        command: undefined,
      });
    }
    return out;
  }

  // ----------------------------------------------------- unused capability

  /**
   * Tools an agent may reach and has never used.
   *
   * Blast radius with nothing on the other side of it. This is the proposal
   * that comes straight out of the topology: capability an agent holds, is not
   * exercising, and could lose at no cost to what it actually does.
   */
  #unusedCapability(tenantId: string, range: TimeRange): Proposal[] {
    /*
     * Only for agents with enough traffic for "never used" to mean something.
     *
     * A tool that went uncalled across two requests is not an unused
     * capability, it is two requests. Without this the check fires on the
     * first afternoon of a trial and tells a customer to remove a tool their
     * agent simply had not reached yet — which is how a useful list becomes
     * one people stop reading.
     */
    const active = new Set(
      (
        this.#db
          .prepare(
            `SELECT agent_id AS agentId FROM calls
             WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
             GROUP BY agent_id HAVING COUNT(*) >= ?`,
          )
          .all(tenantId, range.from, range.to, MIN_CALLS_TO_GENERALISE) as { agentId: string }[]
      ).map((r) => r.agentId),
    );
    if (active.size === 0) return [];

    const rows = this.#db
      .prepare(
        `SELECT g.agent_id AS agentId, g.tool_name AS toolName
         FROM tool_grants g
         WHERE g.tenant_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM tool_invocations i
             WHERE i.tenant_id = g.tenant_id
               AND i.agent_id = g.agent_id
               AND i.tool_name = g.tool_name
               AND i.occurred_at >= ? AND i.occurred_at < ?
           )
         ORDER BY g.agent_id, g.tool_name`,
      )
      .all(tenantId, range.from, range.to) as { agentId: string; toolName: string }[];

    const byAgent = new Map<string, string[]>();
    for (const row of rows) {
      if (!active.has(row.agentId)) continue;
      const list = byAgent.get(row.agentId) ?? [];
      list.push(row.toolName);
      byAgent.set(row.agentId, list);
    }

    const out: Proposal[] = [];
    for (const [agentId, tools] of byAgent) {
      out.push({
        kind: "unused-capability",
        intent: "guardrail",
        headline: `${agentId} can reach ${tools.length} tool(s) it never used`,
        evidence:
          `Granted but never invoked in this window: ${tools.join(", ")}. ` +
          "Capability an agent is not exercising is blast radius with nothing on " +
          "the other side of it.",
        rule: { kind: "tool-denylist", tools },
        scope: { kind: "agent", agentId },
        // Not backtested: tool rules fire on the tool list in a request, and
        // requests are not stored. Saying so beats a confident zero.
        backtest: undefined,
        /*
         * Weight zero, so this never outranks a money proposal. It is a real
         * finding and it saves nothing — a tool that was never called was
         * never billed — and pretending otherwise to climb the list would be
         * the first dishonest number in the product.
         */
        weight: 0n,
        command: `costgrid policy deny-tool agent:${agentId} ${tools.join(" ")} --action monitor`,
      });
    }
    return out;
  }

  // ------------------------------------------------------------- long runs

  /**
   * Runs that took an unusual number of steps.
   *
   * This is the only loop signal available from metered rows that is worth
   * anything. CostGrid sees neither prompts nor results, so it cannot tell a
   * runaway loop from a long piece of legitimate work — but a run's step count
   * is a fact, and it maps directly onto the rule that would bound it.
   */
  #longRuns(tenantId: string, range: TimeRange): Proposal[] {
    const rows = this.#db
      .prepare(
        `SELECT agent_id AS agentId, run_id AS runId,
                COUNT(*) AS steps, SUM(cost_total) AS cost
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND run_declared = 1
           AND started_at >= ? AND started_at < ?
         GROUP BY run_id
         HAVING steps >= ?`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to, LONG_RUN_STEPS) as unknown as {
      agentId: string;
      runId: string;
      steps: bigint;
      cost: bigint;
    }[];

    // One proposal per agent, from its longest run: a fleet that loops once
    // loops repeatedly, and listing every instance buries everything else.
    const worst = new Map<string, { steps: bigint; runId: string }>();
    const total = new Map<string, bigint>();
    for (const row of rows) {
      const seen = worst.get(row.agentId);
      if (seen === undefined || row.steps > seen.steps) {
        worst.set(row.agentId, { steps: row.steps, runId: row.runId });
      }
      total.set(row.agentId, (total.get(row.agentId) ?? 0n) + row.cost);
    }

    const out: Proposal[] = [];
    for (const [agentId, peak] of worst) {
      const spend = total.get(agentId) ?? 0n;
      if (spend < MIN_SPEND_TO_MENTION) continue;

      // Half again as long as the longest run seen. Set at the observed peak a
      // cap fires on the next normal run, and a rule that cries wolf gets
      // switched off rather than tuned.
      const limit = Math.ceil((Number(peak.steps) * 3) / 2);
      const scope: PolicyScope = { kind: "agent", agentId };
      const rule: PolicyRule = { kind: "run-steps", limit };

      out.push({
        kind: "long-run",
        intent: "guardrail",
        headline: `${agentId} has runs of ${peak.steps} steps`,
        evidence:
          `Longest run in this window: ${peak.steps} call(s) (${peak.runId}), ` +
          `${money(spend)} across all its long runs. CostGrid cannot see whether that ` +
          "is a loop or long legitimate work, but a cap is the difference between " +
          "finding out at step 40 and finding out on the invoice.",
        rule,
        scope,
        backtest: this.#backtester.run(tenantId, scope, rule, range),
        weight: spend,
        command: `costgrid policy run-steps agent:${agentId} ${limit} --action monitor`,
      });
    }
    return out;
  }

  // -------------------------------------------------------- no run context

  /**
   * A fleet with real traffic and no run headers at all.
   *
   * Not a rule to apply — a prerequisite that is missing. Every run-level
   * control in the product is unavailable to this customer and there is
   * nothing in the dashboard that would tell them why, because the rules they
   * never created cannot report that they would not have fired.
   */
  #noRunContext(tenantId: string, range: TimeRange): Proposal[] {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS calls,
                SUM(CASE WHEN run_declared = 1 THEN 1 ELSE 0 END) AS declared,
                SUM(cost_total) AS cost
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?`,
      )
      .safeIntegers(true)
      .get(tenantId, range.from, range.to) as {
      calls: bigint;
      declared: bigint;
      cost: bigint;
    };

    if (Number(row.calls) < MIN_CALLS_FOR_COVERAGE_ADVICE) return [];
    if (row.declared > 0n) return [];
    if (row.cost < MIN_SPEND_TO_MENTION) return [];

    return [
      {
        kind: "no-run-context",
        intent: "finding",
        headline: "No traffic carries a run id, so run-level rules cannot fire",
        evidence:
          `${row.calls} call(s) in this window, none with an x-costgrid-run header. ` +
          "Per-run budgets, step caps, depth limits and the transitive half of a tool " +
          "boundary all need one. They can be created without it and will sit there " +
          "doing nothing.",
        rule: undefined,
        scope: { kind: "tenant" },
        backtest: undefined,
        // Weighted at nothing: it saves nothing by itself. It unlocks the
        // controls that do.
        weight: 0n,
        command: undefined,
      },
    ];
  }

  /** Does this agent's traffic carry run ids at all? */
  #declaresRuns(tenantId: string, agentId: string, range: TimeRange): boolean {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM calls
         WHERE tenant_id = ? AND agent_id = ? AND run_declared = 1
           AND started_at >= ? AND started_at < ?`,
      )
      .get(tenantId, agentId, range.from, range.to) as { n: number };
    return row.n > 0;
  }
}

/**
 * The cheapest priceable model from the same provider, for a route proposal.
 *
 * Same provider because a cross-provider body rewrite is not valid, which the
 * live evaluator enforces too — proposing a substitution the gateway would
 * refuse to make would be proposing a rule that silently does nothing.
 */
function cheapestSameProvider(provider: Provider, from: string): string | undefined {
  let best: { id: string; output: Nanodollars } | undefined;
  for (const price of listModelPrices(provider)) {
    if (price.retired) continue;
    if (!substitutionAllowed(from, price.id)) continue;
    if (best === undefined || price.output < best.output) {
      best = { id: price.id, output: price.output };
    }
  }
  return best?.id;
}

function usd(nano: Nanodollars): string {
  return (Number(nano) / 1e9).toFixed(2);
}

function money(nano: Nanodollars): string {
  return `$${usd(nano)}`;
}
