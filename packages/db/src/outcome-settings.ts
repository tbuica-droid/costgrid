import type { Db } from "./database.js";

/**
 * Whether an organisation matches repeat jobs by a one-way code of their
 * first message. On unless the owner turns it off; turning it off also
 * forgets every code already saved, so "off" means none are kept.
 */
export class OutcomeSettingsRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  fingerprintEnabled(tenantId: string): boolean {
    const row = this.#db.prepare("SELECT fingerprint FROM outcome_settings WHERE tenant_id = ?").get(tenantId) as
      | { fingerprint: number }
      | undefined;
    return row === undefined || row.fingerprint === 1;
  }

  /** Returns how many saved codes were forgotten (always 0 when turning it on). */
  setFingerprint(tenantId: string, enabled: boolean): number {
    return this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO outcome_settings (tenant_id, fingerprint, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (tenant_id) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
        )
        .run(tenantId, enabled ? 1 : 0, Date.now());
      if (enabled) return 0;
      return this.#db
        .prepare(
          `UPDATE calls SET task_key = NULL, task_source = NULL
           WHERE tenant_id = ? AND task_source = 'fingerprint'`,
        )
        .run(tenantId).changes;
    })();
  }
}
