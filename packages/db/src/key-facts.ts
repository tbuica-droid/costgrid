import { type KeyFact, type KeyStatus, type Provider } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * What each provider's key list said about the organisation's API keys at
 * the last sync that could read it. Metadata only; see `schema-keys.ts`.
 */
export class KeyFactsRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Replaces everything known about one provider's keys with what its list returned now. */
  replace(tenantId: string, provider: Provider, keys: readonly KeyFact[]): void {
    const insert = this.#db.prepare(
      `INSERT INTO provider_keys (tenant_id, provider, key_id, label, status, key_created_at, last_used_at,
         owner_kind, default_workspace, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, provider, key_id) DO NOTHING`,
    );
    const now = Date.now();
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM provider_keys WHERE tenant_id = ? AND provider = ?").run(tenantId, provider);
      for (const k of keys) {
        if (k.provider !== provider || k.id === "") continue;
        insert.run(
          tenantId,
          provider,
          k.id,
          k.label,
          k.status,
          k.createdAt,
          k.lastUsedAt,
          k.ownerKind,
          k.defaultWorkspace === null ? null : k.defaultWorkspace ? 1 : 0,
          now,
        );
      }
    })();
  }

  list(tenantId: string): KeyFact[] {
    const rows = this.#db
      .prepare(
        `SELECT provider, key_id AS id, label, status, key_created_at AS createdAt, last_used_at AS lastUsedAt,
                owner_kind AS ownerKind, default_workspace AS defaultWorkspace
         FROM provider_keys WHERE tenant_id = ? ORDER BY provider, key_id`,
      )
      .all(tenantId) as (Omit<KeyFact, "defaultWorkspace" | "status"> & { status: KeyStatus; defaultWorkspace: number | null })[];
    return rows.map((r) => ({ ...r, defaultWorkspace: r.defaultWorkspace === null ? null : r.defaultWorkspace === 1 }));
  }
}
