import { type Nanodollars, type Provider, twins } from "@costgrid/core";
import type { Db } from "./database.js";
import { type SourceKind, type SourceRow, SourcesRepository } from "./sources.js";

/**
 * Agents: the jobs an owner's AI does, and the provider sources each one uses.
 *
 * An agent is either one the owner named in setup ("Support bot") or one the
 * proxy saw in traffic, by its `x-costgrid-agent` value or gateway key name.
 * Both live in `agents`, so naming an agent also gives developers the id that
 * puts proxied traffic on it.
 *
 * Imported provider usage and metered proxy calls are reported side by side
 * and never added together: one is a daily total someone else assembled, the
 * other is calls CostGrid watched go past.
 */

export type AgentOrigin = "proxy" | "owner";

export interface SourceKey {
  readonly provider: Provider;
  readonly kind: SourceKind;
  /** '' for the account. */
  readonly id: string;
}

export interface Metered {
  readonly costNano: Nanodollars;
  readonly calls: number;
}

export interface AgentRow {
  readonly id: string;
  readonly name: string | null;
  readonly purposeId: string | null;
  readonly purposeVersion: string | null;
  readonly origin: AgentOrigin;
  readonly lastSeenAt: number | null;
  readonly sources: SourceRow[];
  /** Provider usage for its sources; `estimatedNano` is the list-price part of `costNano`. */
  readonly imported: { readonly costNano: Nanodollars; readonly estimatedNano: Nanodollars };
  /** Calls measured through the proxy under this agent's id. */
  readonly metered: Metered;
}

export interface AgentsView {
  /** Agents with a name or with sources, dearest imported cost first. */
  readonly agents: AgentRow[];
  readonly unassigned: SourceRow[];
  readonly shared: SourceRow[];
  /** Agents the proxy saw that nobody has named or given a source yet. */
  readonly proxyOnly: { id: string; lastSeenAt: number | null; metered: Metered }[];
}

export type AssignResult = "ok" | "no-source" | "no-agent";

const DAY_MS = 86_400_000;
const ZERO: Metered = { costNano: 0n, calls: 0 };

const sameSource = (a: SourceKey, b: SourceKey): boolean =>
  a.provider === b.provider && a.kind === b.kind && a.id === b.id;

/** A readable id from a name: "Support bot" → "support-bot". */
export function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug === "" ? "agent" : slug;
}

interface AgentRecord {
  id: string;
  name: string | null;
  purposeId: string | null;
  purposeVersion: string | null;
  origin: AgentOrigin;
  lastSeenAt: number | null;
}

export class AgentsRepository {
  readonly #db: Db;
  readonly #sources: SourcesRepository;

  constructor(db: Db) {
    this.#db = db;
    this.#sources = new SourcesRepository(db);
  }

  /** Every agent with its sources and costs between two UTC days, plus what is not on an agent yet. */
  view(tenantId: string, range: { from: string; to: string }): AgentsView {
    const sources = this.#sources.list(tenantId, range);
    const metered = this.#metered(tenantId, range);
    const records = this.#db
      .prepare(
        `SELECT id, name, purpose_id AS purposeId, purpose_version AS purposeVersion, origin,
                last_seen_at AS lastSeenAt
         FROM agents WHERE tenant_id = ?`,
      )
      .all(tenantId) as AgentRecord[];

    const agents: AgentRow[] = [];
    const proxyOnly: AgentsView["proxyOnly"] = [];
    for (const record of records) {
      const own = sources.filter((s) => s.agentId === record.id);
      if (record.name === null && own.length === 0) {
        if (record.origin === "proxy") {
          proxyOnly.push({ id: record.id, lastSeenAt: record.lastSeenAt, metered: metered.get(record.id) ?? ZERO });
        }
        continue;
      }
      agents.push({
        ...record,
        sources: own,
        imported: {
          costNano: own.reduce((sum, s) => sum + s.costNano, 0n),
          estimatedNano: own.reduce((sum, s) => sum + s.estimatedNano, 0n),
        },
        metered: metered.get(record.id) ?? ZERO,
      });
    }
    agents.sort((a, b) =>
      a.imported.costNano === b.imported.costNano
        ? (a.name ?? a.id).localeCompare(b.name ?? b.id)
        : a.imported.costNano > b.imported.costNano ? -1 : 1,
    );
    proxyOnly.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));

    return {
      agents,
      unassigned: sources.filter((s) => s.agentId === null && !s.shared),
      shared: sources.filter((s) => s.shared),
      proxyOnly,
    };
  }

  exists(tenantId: string, id: string): boolean {
    return this.#db.prepare("SELECT 1 FROM agents WHERE tenant_id = ? AND id = ?").get(tenantId, id) !== undefined;
  }

  /**
   * A new agent, with an id made from its name, or a name for an agent the
   * proxy already saw (`linkProxyId`). Returns the id, or undefined when the
   * proxy agent to link does not exist or is already named.
   */
  create(
    tenantId: string,
    p: { name: string; purposeId?: string; purposeVersion?: string; linkProxyId?: string },
  ): string | undefined {
    const purposeId = p.purposeId ?? null;
    const purposeVersion = purposeId === null ? null : (p.purposeVersion ?? null);
    if (p.linkProxyId !== undefined) {
      const named = this.#db
        .prepare(
          `UPDATE agents SET name = ?, purpose_id = ?, purpose_version = ?
           WHERE tenant_id = ? AND id = ? AND origin = 'proxy' AND name IS NULL`,
        )
        .run(p.name, purposeId, purposeVersion, tenantId, p.linkProxyId);
      return named.changes > 0 ? p.linkProxyId : undefined;
    }

    return this.#db.transaction(() => {
      const base = slugOf(p.name);
      let id = base;
      for (let n = 2; this.exists(tenantId, id); n += 1) id = `${base}-${n}`;
      this.#db
        .prepare(
          `INSERT INTO agents (id, tenant_id, name, purpose_id, purpose_version, origin, created_at)
           VALUES (?, ?, ?, ?, ?, 'owner', ?)`,
        )
        .run(id, tenantId, p.name, purposeId, purposeVersion, Date.now());
      return id;
    })();
  }

  /** Rename an agent or change its purpose; `purposeId: ""` clears it. False when there is no such agent. */
  update(tenantId: string, id: string, p: { name?: string; purposeId?: string; purposeVersion?: string }): boolean {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (p.name !== undefined) {
      sets.push("name = ?");
      values.push(p.name);
    }
    if (p.purposeId !== undefined) {
      const purposeId = p.purposeId === "" ? null : p.purposeId;
      sets.push("purpose_id = ?", "purpose_version = ?");
      values.push(purposeId, purposeId === null ? null : (p.purposeVersion ?? null));
    }
    if (sets.length === 0) return this.exists(tenantId, id);
    return (
      this.#db
        .prepare(`UPDATE agents SET ${sets.join(", ")} WHERE tenant_id = ? AND id = ?`)
        .run(...values, tenantId, id).changes > 0
    );
  }

  /**
   * Remove an agent the owner made, and take its sources off it. An agent the
   * proxy saw keeps its id, which recorded calls refer to, and only loses its
   * name and purpose.
   */
  remove(tenantId: string, id: string): boolean {
    return this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT origin FROM agents WHERE tenant_id = ? AND id = ?").get(tenantId, id) as
        | { origin: AgentOrigin }
        | undefined;
      if (row === undefined) return false;
      this.#db
        .prepare(
          `UPDATE usage_sources SET agent_id = NULL, assigned_by = NULL, assigned_at = NULL
           WHERE tenant_id = ? AND agent_id = ?`,
        )
        .run(tenantId, id);
      if (row.origin === "owner") {
        this.#db.prepare("DELETE FROM agents WHERE tenant_id = ? AND id = ?").run(tenantId, id);
      } else {
        this.#db
          .prepare("UPDATE agents SET name = NULL, purpose_id = NULL, purpose_version = NULL WHERE tenant_id = ? AND id = ?")
          .run(tenantId, id);
        // The owner's estimates go with the name, so they do not come back if the id is named again.
        for (const table of ["agent_person_cost", "agent_job_counts", "agent_caps"]) {
          this.#db.prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND agent_id = ?`).run(tenantId, id);
        }
      }
      return true;
    })();
  }

  /**
   * Put a source on an agent, mark it shared, or take it off (`agentId: null`).
   * A shared source never has an agent, so its cost is never given to one job.
   */
  assign(
    tenantId: string,
    source: SourceKey,
    p: { agentId: string | null; shared: boolean; by: "owner" | "match" },
  ): AssignResult {
    if (p.agentId !== null && p.shared) throw new RangeError("a shared source cannot have an agent");
    if (p.agentId !== null && !this.exists(tenantId, p.agentId)) return "no-agent";
    const changes = this.#db
      .prepare(
        `UPDATE usage_sources SET agent_id = ?, shared = ?, assigned_by = ?, assigned_at = ?
         WHERE tenant_id = ? AND provider = ? AND source_kind = ? AND source_id = ?`,
      )
      .run(
        p.agentId,
        p.shared ? 1 : 0,
        p.by,
        Date.now(),
        tenantId,
        source.provider,
        source.kind,
        source.kind === "account" ? "" : source.id,
      ).changes;
    return changes > 0 ? "ok" : "no-source";
  }

  /**
   * Give each source nobody has decided about the agent, or the shared mark,
   * of its twin: the same Claude key seen in a usage file and through the
   * admin API. Returns the sources it changed, for the audit log.
   */
  matchTwins(tenantId: string): { source: SourceKey; agentId: string | null; shared: boolean }[] {
    const rows = this.#db
      .prepare(
        `SELECT provider, source_kind AS kind, source_id AS id, parent_id AS parentId,
                provider_label AS label, parent_label AS parentLabel,
                agent_id AS agentId, shared, assigned_by AS assignedBy
         FROM usage_sources WHERE tenant_id = ? AND provider = 'anthropic'`,
      )
      .all(tenantId) as (SourceKey & {
      parentId: string | null;
      label: string | null;
      parentLabel: string | null;
      agentId: string | null;
      shared: number;
      assignedBy: "owner" | "match" | null;
    })[];

    const changed: { source: SourceKey; agentId: string | null; shared: boolean }[] = [];
    for (const pair of twins(rows)) {
      const decided = pair.find((s) => s.assignedBy !== null && (s.agentId !== null || s.shared === 1));
      const open = pair.find((s) => s.assignedBy === null);
      if (decided === undefined || open === undefined || sameSource(decided, open)) continue;
      const source = { provider: open.provider, kind: open.kind, id: open.id };
      this.assign(tenantId, source, { agentId: decided.agentId, shared: decided.shared === 1, by: "match" });
      changed.push({ source, agentId: decided.agentId, shared: decided.shared === 1 });
    }
    return changed;
  }

  /** Proxied calls per agent id over the range of UTC days, kept apart from imported usage. */
  #metered(tenantId: string, range: { from: string; to: string }): Map<string, Metered> {
    const from = Date.parse(`${range.from}T00:00:00Z`);
    const to = Date.parse(`${range.to}T00:00:00Z`) + DAY_MS;
    const rows = this.#db
      .prepare(
        `SELECT agent_id AS id, COALESCE(SUM(cost_total), 0) AS cost, COUNT(*) AS calls
         FROM calls WHERE tenant_id = ? AND started_at >= ? AND started_at < ?
         GROUP BY agent_id`,
      )
      .safeIntegers(true)
      .all(tenantId, from, to) as { id: string; cost: bigint; calls: bigint }[];
    return new Map(rows.map((r) => [r.id, { costNano: r.cost, calls: Number(r.calls) }]));
  }
}
