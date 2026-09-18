import { randomUUID } from "node:crypto";
import { type Nanodollars, type PolicyRule, type PolicyScope, toUsdString } from "@costgrid/core";
import { Advisor, type Proposal } from "./advise.js";
import { Analytics, type TimeRange } from "./analytics.js";
import type { Db } from "./database.js";
import { CostGridRepository } from "./repositories.js";

/**
 * CostGrid acting on its own findings, inside limits the customer sets.
 *
 * This is the only part of the product that changes a customer's
 * configuration without a person typing the command, so the constraints are
 * the design rather than a wrapper around it:
 *
 *   1. **It cannot refuse a call.** No rule it creates blocks, denies or caps
 *      anything. The worst outcome of a mistake here is traffic served by a
 *      cheaper model than it needed, which shows up in the next report and
 *      undoes in one command. Breaking a customer's product at 3am is not a
 *      risk anyone gets to take on their behalf.
 *   2. **It cannot set a budget.** A budget is a statement about what an
 *      organisation is willing to spend. Nothing here knows that.
 *   3. **It only acts on a replay.** Every action carries the backtest that
 *      justified it, stored as it stood at the time.
 *   4. **Blast radius is capped** as a share of window spend, and the number
 *      of actions per run is capped too, so one bad window cannot rewrite a
 *      policy set.
 *   5. **Undo is one command** and restores the previous state exactly,
 *      because it only ever has to disable what it created.
 *
 * `monitor` is the level worth defaulting to. It creates rules that change
 * nothing and start measuring, which is the whole of what most fleets need
 * from automation: someone remembering to turn the measurement on.
 */

export type AutopilotLevel = "off" | "monitor" | "apply";

export interface AutopilotSettings {
  readonly level: AutopilotLevel;
  /** Ceiling on the share of window spend a single action may redirect. */
  readonly maxImpactPct: number;
  readonly maxActions: number;
}

export interface AutopilotAction {
  readonly id: string;
  readonly policyId: string;
  readonly kind: string;
  readonly summary: string;
  readonly evidence: string;
  readonly level: AutopilotLevel;
  readonly actedAt: number;
  readonly undoneAt: number | undefined;
}

export interface AutopilotRun {
  readonly level: AutopilotLevel;
  readonly considered: number;
  readonly taken: readonly AutopilotAction[];
  /** Proposals it declined, and the reason, so silence is never unexplained. */
  readonly declined: readonly { headline: string; because: string }[];
}

/*
 * 50%, not 20%. The cap exists so software cannot re-route an entire estate
 * unattended, and the honest reading of "how much is too much" is "most of
 * it", not "a fifth". Set lower deliberately; a cap so tight that nothing ever
 * passes it is a feature that looks broken rather than one that is careful.
 */
const DEFAULTS: AutopilotSettings = { level: "off", maxImpactPct: 50, maxActions: 3 };

function usd(nano: Nanodollars): string {
  return `$${toUsdString(nano, 2)}`;
}

export class Autopilot {
  readonly #db: Db;
  readonly #repository: CostGridRepository;
  readonly #advisor: Advisor;
  readonly #analytics: Analytics;

  constructor(db: Db) {
    this.#db = db;
    this.#repository = new CostGridRepository(db);
    this.#advisor = new Advisor(db);
    this.#analytics = new Analytics(db);
  }

  settings(tenantId: string): AutopilotSettings {
    const row = this.#db
      .prepare(
        `SELECT level, max_impact_pct AS maxImpactPct, max_actions AS maxActions
         FROM autopilot WHERE tenant_id = ?`,
      )
      .get(tenantId) as AutopilotSettings | undefined;
    return row ?? DEFAULTS;
  }

  configure(tenantId: string, settings: Partial<AutopilotSettings>): AutopilotSettings {
    const merged = { ...this.settings(tenantId), ...settings };
    this.#db
      .prepare(
        `INSERT INTO autopilot (tenant_id, level, max_impact_pct, max_actions, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           level = excluded.level,
           max_impact_pct = excluded.max_impact_pct,
           max_actions = excluded.max_actions,
           updated_at = excluded.updated_at`,
      )
      .run(tenantId, merged.level, merged.maxImpactPct, merged.maxActions, Date.now());
    return merged;
  }

  /**
   * Consider every proposal and act on the ones inside the limits.
   *
   * Declining is recorded and returned rather than passed over in silence: a
   * customer who switched this on deserves to know it looked and chose not to,
   * and why, or the feature is indistinguishable from one that is broken.
   */
  run(tenantId: string, range: TimeRange): AutopilotRun {
    const settings = this.settings(tenantId);
    if (settings.level === "off") {
      return { level: "off", considered: 0, taken: [], declined: [] };
    }

    const proposals = this.#advisor.proposals(tenantId, range);
    const windowSpend = this.#analytics.summary(tenantId, range).totalCost;
    const existing = this.#existingRules(tenantId);

    const taken: AutopilotAction[] = [];
    const declined: { headline: string; because: string }[] = [];

    for (const proposal of proposals) {
      if (taken.length >= settings.maxActions) {
        declined.push({
          headline: proposal.headline,
          because: `already took ${settings.maxActions} action(s) this run, which is the limit`,
        });
        continue;
      }

      const verdict = this.#eligible(proposal, settings, windowSpend, existing);
      if (verdict !== undefined) {
        declined.push({ headline: proposal.headline, because: verdict });
        continue;
      }

      taken.push(this.#act(tenantId, proposal, settings));
    }

    return { level: settings.level, considered: proposals.length, taken, declined };
  }

  /** Why this proposal cannot be acted on, or `undefined` when it can. */
  #eligible(
    proposal: Proposal,
    settings: AutopilotSettings,
    windowSpend: Nanodollars,
    existing: Set<string>,
  ): string | undefined {
    const rule = proposal.rule;
    if (rule === undefined) return "there is no rule to create; it needs a change in your own code";

    /*
     * The hard boundary. A route rule serves the call on a cheaper model; the
     * worst case is a weaker answer, visible in the next report and reversible.
     * Everything else here either refuses traffic or commits an organisation to
     * a number, and neither is a decision software gets to make unattended.
     */
    if (rule.kind !== "route") {
      return `autopilot only creates routing rules, and this is a ${rule.kind} rule`;
    }

    const backtest = proposal.backtest;
    if (backtest === undefined) return "it could not be replayed against your traffic";
    if (backtest.amount === undefined || backtest.amount <= 0n) {
      return "the replay did not show a saving";
    }
    if (backtest.callsAffected === 0) return "the replay says it would never have fired";

    if (existing.has(this.#signature(proposal.scope, rule))) {
      return "a rule like this already exists";
    }

    /*
     * Blast radius, but only where there is any.
     *
     * At `monitor` the rule alters no request, so the share of spend it sits
     * in front of is not a risk, it is a measurement. Applying the cap here
     * was the first version and it was wrong twice over: it blocked the safest
     * level entirely, and on a fleet where one agent is most of the traffic it
     * meant autopilot could never do the one thing it is for.
     */
    if (settings.level === "apply" && windowSpend > 0n) {
      const share = Number((backtest.spendInScope * 100n) / windowSpend);
      if (share > settings.maxImpactPct) {
        return (
          `it covers ${share}% of your spend, over the ${settings.maxImpactPct}% ` +
          "limit you set"
        );
      }
    }

    return undefined;
  }

  #act(tenantId: string, proposal: Proposal, settings: AutopilotSettings): AutopilotAction {
    /*
     * At `monitor` the rule is created as a dry run: it records what it would
     * have done and changes not one request. At `apply` it is created live.
     * The level decides this and nothing else does.
     */
    const action = settings.level === "apply" ? "warn" : "monitor";
    const backtest = proposal.backtest!;

    const policyId = this.#repository.createPolicy(tenantId, {
      name: `autopilot: ${proposal.headline}`,
      scope: proposal.scope,
      rule: proposal.rule!,
      action,
      enabled: true,
    });

    const summary =
      settings.level === "apply"
        ? `Switched on a routing rule. ${proposal.headline}.`
        : `Started measuring a routing rule. It changes nothing. ${proposal.headline}.`;
    const evidence =
      `Replay over the window: ${backtest.callsAffected} of ${backtest.callsInScope} call(s), ` +
      `about ${usd(backtest.amount!)} saved, against ${usd(backtest.spendInScope)} of spend in scope.`;

    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO autopilot_actions
           (id, tenant_id, policy_id, kind, summary, evidence, level, acted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tenantId, policyId, proposal.kind, summary, evidence, settings.level, Date.now());

    return {
      id,
      policyId,
      kind: proposal.kind,
      summary,
      evidence,
      level: settings.level,
      actedAt: Date.now(),
      undoneAt: undefined,
    };
  }

  actions(tenantId: string, limit = 50): AutopilotAction[] {
    const rows = this.#db
      .prepare(
        `SELECT id, policy_id AS policyId, kind, summary, evidence, level,
                acted_at AS actedAt, undone_at AS undoneAt
         FROM autopilot_actions WHERE tenant_id = ?
         ORDER BY acted_at DESC LIMIT ?`,
      )
      .all(tenantId, limit) as (Omit<AutopilotAction, "undoneAt"> & { undoneAt: number | null })[];
    return rows.map((r) => ({ ...r, undoneAt: r.undoneAt ?? undefined }));
  }

  /**
   * Switch off everything autopilot turned on, in one call.
   *
   * Disables rather than deletes, so the record of what was tried survives.
   * That matters more than tidiness: "CostGrid changed something and I do not
   * know what" is the fear this feature has to answer, and an empty table
   * answers it badly.
   */
  undoAll(tenantId: string): number {
    const live = this.#db
      .prepare(
        `SELECT id, policy_id AS policyId FROM autopilot_actions
         WHERE tenant_id = ? AND undone_at IS NULL`,
      )
      .all(tenantId) as { id: string; policyId: string }[];

    const now = Date.now();
    const markUndone = this.#db.prepare(
      "UPDATE autopilot_actions SET undone_at = ? WHERE id = ?",
    );

    const undo = this.#db.transaction(() => {
      for (const row of live) {
        this.#repository.setPolicyEnabled(row.policyId, false);
        markUndone.run(now, row.id);
      }
    });
    undo();
    return live.length;
  }

  /** Rules already in force, so the same one is never created twice. */
  #existingRules(tenantId: string): Set<string> {
    const out = new Set<string>();
    for (const policy of this.#repository.listPolicies(tenantId)) {
      if (!policy.enabled) continue;
      out.add(this.#signature(policy.scope, policy.rule));
    }
    return out;
  }

  #signature(scope: PolicyScope, rule: PolicyRule): string {
    const where =
      scope.kind === "tenant"
        ? "tenant"
        : scope.kind === "agent"
          ? `agent:${scope.agentId}`
          : `dept:${scope.department}`;
    if (rule.kind !== "route") return `${where}|${rule.kind}`;
    return `${where}|route|${(rule.from ?? []).join(",")}|${rule.toModel}`;
  }
}
