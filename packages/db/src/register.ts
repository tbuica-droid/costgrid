import type { EnforcementAction, PolicyRule, PolicyScope } from "@costgrid/core";
import type { Db } from "./database.js";
import type { TimeRange } from "./analytics.js";
import type { CostGridRepository } from "./repositories.js";

/**
 * The rule register: every rule, who owns it, why it exists, and what it has
 * done.
 *
 * The argument for this comes from Hydari and Muzaffar's "rule debt"
 * (arXiv:2605.23179). When an organisation's decision rules move out of the
 * systems that used to hold them and into the layer where automated work runs,
 * they turn into scattered policy fragments that eventually have to be
 * inventoried, owned, versioned, tested and reconciled. A spending limit set
 * in CostGrid is exactly such a rule. This makes each one an accountable
 * record rather than a row in a table: an owner, a reason, when it went live,
 * when it last fired, and the history of every change from the audit log.
 *
 * It is also the inventory NIST AI RMF GOVERN 1.6 asks for, scoped to the
 * controls CostGrid itself enforces.
 */

export interface RegisterEntry {
  readonly id: string;
  readonly name: string;
  readonly scope: PolicyScope;
  readonly rule: PolicyRule;
  readonly action: EnforcementAction;
  readonly enabled: boolean;
  /** Who answers for this rule. Null when nobody was named, which is itself a finding. */
  readonly owner: string | null;
  readonly reason: string | null;
  readonly createdAt: number;
  /** When it last started enforcing. Null for a rule that has only ever measured. */
  readonly liveSince: number | null;
  /** Times it fired in the window, by the action it took. */
  readonly fired: { readonly block: number; readonly warn: number; readonly monitor: number };
  readonly lastFiredAt: number | null;
  /** Changes to this rule recorded in the audit log, oldest first. */
  readonly history: readonly { readonly at: number; readonly action: string; readonly by: string }[];
}

export class RuleRegister {
  readonly #db: Db;
  readonly #repository: CostGridRepository;

  constructor(db: Db, repository: CostGridRepository) {
    this.#db = db;
    this.#repository = repository;
  }

  entries(tenantId: string, range: TimeRange): RegisterEntry[] {
    const meta = new Map(
      (
        this.#db
          .prepare(
            `SELECT id, owner, reason, created_at AS createdAt, live_since AS liveSince
             FROM policies WHERE tenant_id = ?`,
          )
          .all(tenantId) as {
          id: string;
          owner: string | null;
          reason: string | null;
          createdAt: number;
          liveSince: number | null;
        }[]
      ).map((row) => [row.id, row]),
    );

    const firings = this.#db
      .prepare(
        `SELECT policy_id AS policyId, action, COUNT(*) AS n, MAX(occurred_at) AS last
         FROM violations
         WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ?
         GROUP BY policy_id, action`,
      )
      .all(tenantId, range.from, range.to) as {
      policyId: string;
      action: EnforcementAction;
      n: number;
      last: number;
    }[];

    const history = this.#db
      .prepare(
        `SELECT subject, occurred_at AS at, action, actor_label AS actor
         FROM audit_log
         WHERE tenant_id = ? AND action LIKE 'policy.%'
         ORDER BY seq`,
      )
      .all(tenantId) as { subject: string; at: number; action: string; actor: string }[];

    return this.#repository.listPolicies(tenantId).map((policy) => {
      const row = meta.get(policy.id);
      const fired = { block: 0, warn: 0, monitor: 0 };
      let lastFiredAt: number | null = null;
      for (const f of firings) {
        if (f.policyId !== policy.id) continue;
        fired[f.action] += f.n;
        lastFiredAt = lastFiredAt === null ? f.last : Math.max(lastFiredAt, f.last);
      }
      return {
        ...policy,
        owner: row?.owner ?? null,
        reason: row?.reason ?? null,
        createdAt: row?.createdAt ?? 0,
        liveSince: row?.liveSince ?? null,
        fired,
        lastFiredAt,
        history: history
          .filter((h) => h.subject === policy.id)
          .map(({ at, action, actor }) => ({ at, action, by: actor })),
      };
    });
  }

  /** Record who owns a rule and why, after the fact. */
  annotate(tenantId: string, policyId: string, change: { owner?: string; reason?: string }): boolean {
    const result = this.#db
      .prepare(
        `UPDATE policies
         SET owner = COALESCE(?, owner), reason = COALESCE(?, reason)
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(change.owner ?? null, change.reason ?? null, tenantId, policyId);
    return result.changes > 0;
  }
}
