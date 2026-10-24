import type { Nanodollars, Provider } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * Where usage came from, and what the owner says each source is for.
 *
 * A provider reports usage per API key, per Claude workspace or per OpenAI
 * project. Each of those is usually one workflow, so it is the unit an owner
 * can name ("the support bot") and give a purpose to without knowing anything
 * about how the software was built. When the provider does not say, the usage
 * belongs to the whole account.
 *
 * Also the metadata of a stored admin key. The key itself is never here: it
 * lives in the operating system's keychain, and this table only knows that one
 * exists, what it looked like, when it expires and how its last sync went.
 */

export type SourceKind = "key" | "workspace" | "project" | "account";

export const SOURCE_KINDS: readonly SourceKind[] = ["key", "workspace", "project", "account"];

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && (SOURCE_KINDS as readonly string[]).includes(value);
}

/** A source as an importer sees it. */
export interface SourceRef {
  readonly provider: Provider;
  readonly kind: SourceKind;
  /** The provider's id, or a name where that is all a usage file gives. '' for the account. */
  readonly id: string;
  /** The workspace or project a key belongs to. */
  readonly parentId?: string;
  /** The provider's own name for it, when it could be looked up. */
  readonly label?: string;
}

export interface AdminKeyMeta {
  readonly provider: Provider;
  readonly hint: string;
  /** Epoch ms; null means the owner chose "never". */
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly lastSyncAt: number | null;
  readonly lastSyncStatus: "ok" | "error" | null;
  readonly lastSyncError: string | null;
}

export interface SourceRow {
  readonly provider: Provider;
  readonly kind: SourceKind;
  readonly id: string;
  readonly parentId: string | null;
  readonly label: string | null;
  readonly name: string | null;
  readonly purposeId: string | null;
  readonly purposeVersion: string | null;
  readonly firstDay: string | null;
  readonly lastDay: string | null;
  /** Imported cost in the requested range: the provider's figure where given, else the catalog's. */
  readonly costNano: Nanodollars;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function checkDays(from: string, to: string): void {
  if (!DAY.test(from) || !DAY.test(to) || from > to) {
    throw new RangeError(`not a range of days: ${from} to ${to}`);
  }
}

/** Empty means "clear it", so a name can be removed as well as changed. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const ADMIN_KEY_COLUMNS = `provider, key_hint AS hint, expires_at AS expiresAt, created_at AS createdAt,
  last_sync_at AS lastSyncAt, last_sync_status AS lastSyncStatus, last_sync_error AS lastSyncError`;

export class SourcesRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Record the sources an import saw over `days`.
   *
   * New sources are added; known ones widen their first and last day and pick
   * up a label or parent when this import found one. A name or purpose the
   * owner gave is never touched here.
   */
  upsertSources(tenantId: string, refs: readonly SourceRef[], days: { first: string; last: string }): void {
    checkDays(days.first, days.last);
    if (refs.length === 0) return;

    // CASE rather than MIN and MAX: SQLite's two-argument MIN returns NULL
    // when either side is NULL, and Postgres spells it LEAST anyway.
    const upsert = this.#db.prepare(
      `INSERT INTO usage_sources (
         tenant_id, provider, source_kind, source_id, parent_id, provider_label,
         first_day, last_day, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, provider, source_kind, source_id) DO UPDATE SET
         parent_id      = COALESCE(excluded.parent_id, usage_sources.parent_id),
         provider_label = COALESCE(excluded.provider_label, usage_sources.provider_label),
         first_day      = CASE WHEN usage_sources.first_day IS NULL
                                 OR excluded.first_day < usage_sources.first_day
                               THEN excluded.first_day ELSE usage_sources.first_day END,
         last_day       = CASE WHEN usage_sources.last_day IS NULL
                                 OR excluded.last_day > usage_sources.last_day
                               THEN excluded.last_day ELSE usage_sources.last_day END`,
    );

    const now = Date.now();
    this.#db.transaction(() => {
      for (const ref of refs) {
        const id = ref.kind === "account" ? "" : ref.id;
        if (ref.kind !== "account" && id === "") {
          throw new RangeError(`a ${ref.kind} source needs an id`);
        }
        upsert.run(
          tenantId,
          ref.provider,
          ref.kind,
          id,
          ref.parentId ?? null,
          ref.label ?? null,
          days.first,
          days.last,
          now,
        );
      }
    })();
  }

  /** Every source, with what its imported usage cost between two UTC days, dearest first. */
  list(tenantId: string, range: { from: string; to: string }): SourceRow[] {
    checkDays(range.from, range.to);
    const rows = this.#db
      .prepare(
        `SELECT s.provider, s.source_kind AS kind, s.source_id AS id, s.parent_id AS parentId,
                s.provider_label AS label, s.display_name AS name,
                s.purpose_id AS purposeId, s.purpose_version AS purposeVersion,
                s.first_day AS firstDay, s.last_day AS lastDay,
                COALESCE(u.cost, 0) AS costNano
         FROM usage_sources s
         LEFT JOIN (
           SELECT provider, source_kind, source_id,
                  SUM(COALESCE(cost_reported, cost_catalog)) AS cost
           FROM imported_usage
           WHERE tenant_id = ? AND day >= ? AND day <= ?
           GROUP BY provider, source_kind, source_id
         ) u ON u.provider = s.provider AND u.source_kind = s.source_kind AND u.source_id = s.source_id
         WHERE s.tenant_id = ?
         ORDER BY costNano DESC, s.provider, s.source_kind, s.source_id`,
      )
      .safeIntegers(true)
      .all(tenantId, range.from, range.to, tenantId) as (Omit<SourceRow, "costNano"> & {
      costNano: bigint;
    })[];
    return rows;
  }

  count(tenantId: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM usage_sources WHERE tenant_id = ?")
      .get(tenantId) as { n: number };
    return row.n;
  }

  /**
   * Name a source and say what it is for. Only the fields given change; an
   * empty string clears one. False when there is no such source.
   */
  setNameAndPurpose(
    tenantId: string,
    provider: Provider,
    kind: SourceKind,
    id: string,
    p: { name?: string; purposeId?: string; purposeVersion?: string },
  ): boolean {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (p.name !== undefined) {
      sets.push("display_name = ?", "named_at = ?");
      values.push(orNull(p.name), Date.now());
    }
    if (p.purposeId !== undefined) {
      const purposeId = orNull(p.purposeId);
      sets.push("purpose_id = ?", "purpose_version = ?");
      values.push(purposeId, purposeId === null ? null : (p.purposeVersion ?? null));
    }

    const where = "tenant_id = ? AND provider = ? AND source_kind = ? AND source_id = ?";
    const key = [tenantId, provider, kind, kind === "account" ? "" : id];
    if (sets.length === 0) {
      return this.#db.prepare(`SELECT 1 FROM usage_sources WHERE ${where}`).get(...key) !== undefined;
    }
    const result = this.#db
      .prepare(`UPDATE usage_sources SET ${sets.join(", ")} WHERE ${where}`)
      .run(...values, ...key);
    return result.changes > 0;
  }

  /** Record that a key is stored. Replacing a key starts its sync history afresh. */
  putAdminKey(
    tenantId: string,
    meta: { provider: Provider; hint: string; expiresAt: number | null; createdAt: number },
  ): void {
    this.#db
      .prepare(
        `INSERT INTO admin_keys (tenant_id, provider, key_hint, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           key_hint         = excluded.key_hint,
           expires_at       = excluded.expires_at,
           created_at       = excluded.created_at,
           last_sync_at     = NULL,
           last_sync_status = NULL,
           last_sync_error  = NULL`,
      )
      .run(tenantId, meta.provider, meta.hint, meta.expiresAt, meta.createdAt);
  }

  adminKeys(tenantId: string): AdminKeyMeta[] {
    return this.#db
      .prepare(`SELECT ${ADMIN_KEY_COLUMNS} FROM admin_keys WHERE tenant_id = ? ORDER BY provider`)
      .all(tenantId) as AdminKeyMeta[];
  }

  /** Every stored key across tenants, for the sync job. */
  allAdminKeys(): (AdminKeyMeta & { tenantId: string })[] {
    return this.#db
      .prepare(
        `SELECT tenant_id AS tenantId, ${ADMIN_KEY_COLUMNS} FROM admin_keys ORDER BY tenant_id, provider`,
      )
      .all() as (AdminKeyMeta & { tenantId: string })[];
  }

  recordSync(tenantId: string, provider: Provider, ok: boolean, error?: string): void {
    this.#db
      .prepare(
        `UPDATE admin_keys SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?
         WHERE tenant_id = ? AND provider = ?`,
      )
      .run(
        Date.now(),
        ok ? "ok" : "error",
        ok ? null : (error ?? "sync failed").slice(0, 500),
        tenantId,
        provider,
      );
  }

  /** Forget a stored key's metadata. Usage it imported stays. */
  deleteAdminKey(tenantId: string, provider: Provider): boolean {
    return (
      this.#db
        .prepare("DELETE FROM admin_keys WHERE tenant_id = ? AND provider = ?")
        .run(tenantId, provider).changes > 0
    );
  }
}
