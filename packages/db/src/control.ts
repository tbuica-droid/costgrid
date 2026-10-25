import { randomUUID } from "node:crypto";
import type { AccessTier, Nanodollars, Provider } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * View and control: the tier, each agent's monthly cap, and the record of
 * every pause and resume CostGrid asked a provider for.
 *
 * The record is the source of truth for what CostGrid paused: a resume only
 * turns back on the keys CostGrid itself turned off, never one the owner
 * paused at the provider for their own reasons.
 */

export interface Cap {
  readonly monthlyCap: Nanodollars;
  readonly updatedAt: number;
}

export type KeyActionKind = "pause" | "resume";
export type KeyActionReason = "owner" | "cap";

export interface KeyAction {
  readonly id: string;
  readonly agentId: string;
  readonly provider: Provider;
  readonly keyId: string;
  readonly action: KeyActionKind;
  readonly reason: KeyActionReason;
  readonly requestedAt: number;
  readonly finishedAt: number | null;
  readonly ok: boolean | null;
  readonly error: string | null;
  readonly usageThrough: number | null;
  readonly capMonth: string | null;
}

const ACTION_COLUMNS = `id, agent_id AS agentId, provider, key_id AS keyId, action, reason, requested_at AS requestedAt,
  finished_at AS finishedAt, ok, error, usage_through AS usageThrough, cap_month AS capMonth`;

type ActionRow = Omit<KeyAction, "ok"> & { ok: number | null };
const toAction = (r: ActionRow): KeyAction => ({ ...r, ok: r.ok === null ? null : r.ok === 1 });

export class ControlRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  tierOf(tenantId: string): AccessTier {
    const row = this.#db.prepare("SELECT tier FROM tenant_tier WHERE tenant_id = ?").get(tenantId) as
      | { tier: AccessTier }
      | undefined;
    return row?.tier ?? "view";
  }

  setTier(tenantId: string, tier: AccessTier): void {
    this.#db
      .prepare(
        `INSERT INTO tenant_tier (tenant_id, tier, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`,
      )
      .run(tenantId, tier, Date.now());
  }

  /** Organisations on View and control with at least one cap: the ones whose usage is worth checking often. */
  tenantsWithCaps(): string[] {
    return (
      this.#db
        .prepare(
          `SELECT DISTINCT c.tenant_id AS tenantId FROM agent_caps c
           JOIN tenant_tier t ON t.tenant_id = c.tenant_id AND t.tier = 'control' ORDER BY c.tenant_id`,
        )
        .all() as { tenantId: string }[]
    ).map((r) => r.tenantId);
  }

  caps(tenantId: string): Map<string, Cap> {
    const rows = this.#db
      .prepare("SELECT agent_id AS agentId, monthly_cap AS monthlyCap, updated_at AS updatedAt FROM agent_caps WHERE tenant_id = ?")
      .safeIntegers(true)
      .all(tenantId) as { agentId: string; monthlyCap: bigint; updatedAt: bigint }[];
    return new Map(rows.map((r) => [r.agentId, { monthlyCap: r.monthlyCap, updatedAt: Number(r.updatedAt) }]));
  }

  /** Sets, or with `null` clears, an agent's cap. False when there is no such agent. */
  setCap(tenantId: string, agentId: string, monthlyCap: Nanodollars | null): boolean {
    const exists = this.#db.prepare("SELECT 1 FROM agents WHERE tenant_id = ? AND id = ?").get(tenantId, agentId);
    if (exists === undefined) return false;
    if (monthlyCap === null) {
      this.#db.prepare("DELETE FROM agent_caps WHERE tenant_id = ? AND agent_id = ?").run(tenantId, agentId);
      return true;
    }
    if (monthlyCap <= 0n) throw new RangeError("a cap must be more than zero");
    this.#db
      .prepare(
        `INSERT INTO agent_caps (tenant_id, agent_id, monthly_cap, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET monthly_cap = excluded.monthly_cap, updated_at = excluded.updated_at`,
      )
      .run(tenantId, agentId, monthlyCap, Date.now());
    return true;
  }

  /** Opens a record before the provider is asked, so a crash mid-request still leaves a trace. */
  startAction(
    tenantId: string,
    a: {
      agentId: string;
      provider: Provider;
      keyId: string;
      action: KeyActionKind;
      reason: KeyActionReason;
      requestedAt: number;
      usageThrough?: number;
      capMonth?: string;
    },
  ): string {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO key_actions (id, tenant_id, agent_id, provider, key_id, action, reason, requested_at, usage_through, cap_month)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tenantId, a.agentId, a.provider, a.keyId, a.action, a.reason, a.requestedAt, a.usageThrough ?? null, a.capMonth ?? null);
    return id;
  }

  finishAction(id: string, ok: boolean, finishedAt: number, error?: string): void {
    this.#db
      .prepare("UPDATE key_actions SET ok = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(ok ? 1 : 0, finishedAt, error ?? null, id);
  }

  /**
   * Keys CostGrid paused and has not resumed: for each key, its latest
   * successful action is a pause.
   */
  pausedKeys(tenantId: string, agentId?: string): KeyAction[] {
    const rows = this.#db
      .prepare(
        `WITH latest AS (
           SELECT ${ACTION_COLUMNS},
                  ROW_NUMBER() OVER (PARTITION BY provider, key_id ORDER BY requested_at DESC, id DESC) AS n
           FROM key_actions WHERE tenant_id = ? AND ok = 1
         )
         SELECT id, agentId, provider, keyId, action, reason, requestedAt, finishedAt, ok, error, usageThrough, capMonth
         FROM latest WHERE n = 1 AND action = 'pause'
           AND (? IS NULL OR agentId = ?)
         ORDER BY agentId, provider, keyId`,
      )
      .all(tenantId, agentId ?? null, agentId ?? null) as ActionRow[];
    return rows.map(toAction);
  }

  /**
   * Whether the cap set at `since` already paused a key of this agent in this
   * month. It pauses once, and an owner's resume then stands; a failed pause
   * does not count, so it is tried again.
   */
  capActedIn(tenantId: string, agentId: string, month: string, since: number): boolean {
    return (
      this.#db
        .prepare(
          `SELECT 1 FROM key_actions WHERE tenant_id = ? AND agent_id = ? AND reason = 'cap' AND action = 'pause'
             AND ok = 1 AND cap_month = ? AND requested_at >= ? LIMIT 1`,
        )
        .get(tenantId, agentId, month, since) !== undefined
    );
  }

  /** The newest actions first. */
  history(tenantId: string, limit = 50): KeyAction[] {
    const rows = this.#db
      .prepare(`SELECT ${ACTION_COLUMNS} FROM key_actions WHERE tenant_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?`)
      .all(tenantId, limit) as ActionRow[];
    return rows.map(toAction);
  }
}
