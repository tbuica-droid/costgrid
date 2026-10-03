import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret, maskSecret } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * Alerts: telling a person, at the moment it happens, that a limit fired.
 *
 * Before this, every enforcement decision CostGrid made was visible only to
 * someone who went and looked. EY's account of agent spend names the failure
 * that leaves: without circuit breakers that tell someone, "the bill is only
 * visible after the damage is done". NIST AI RMF MANAGE 4.3 asks the same of
 * any incident: that it is communicated to the people who own it.
 *
 * Two rules shape this file.
 *
 * **One alert per thing, not per call.** A team that is over its monthly
 * budget is over it on every call for the rest of the month. Alerting on each
 * one would teach the reader to mute the channel within an hour, so every
 * alert carries a dedupe key (the rule and its window, the run, or the rule
 * and the hour) and the database refuses a second alert with the same key.
 *
 * **The address is a secret.** A Slack incoming-webhook URL is a credential:
 * anyone holding it can post to the channel. It is encrypted under the same
 * master key as a provider key and shown back only as a masked hint.
 */

export type AlertKind =
  /** A budget reached its warning threshold. */
  | "budget-warning"
  /** A call was refused before it reached the provider. */
  | "blocked"
  /** Over-budget traffic was moved to a cheaper model instead of refused. */
  | "downgraded"
  /** A run is costing far more than this agent's runs usually do. */
  | "runaway-run"
  /** Someone stopped or resumed an agent, a team or everything. */
  | "stopped"
  /** Sent from the settings screen to prove the channel works. */
  | "test";

export interface AlertInput {
  readonly kind: AlertKind;
  /** One alert per key, ever. See the file comment. */
  readonly dedupeKey: string;
  /** What it is about: an agent, a team, a run id. */
  readonly subject: string;
  /** One or two sentences a person can act on. Never message content. */
  readonly message: string;
}

export interface StoredAlert extends AlertInput {
  readonly id: string;
  readonly tenantId: string;
  readonly occurredAt: number;
  readonly deliveredAt: number | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface AlertSettings {
  readonly webhookConfigured: boolean;
  /** Masked tail of the address, for recognition only. */
  readonly webhookHint: string | null;
  /** Show a notification on this computer (desktop app only). */
  readonly desktop: boolean;
}

/** Only https, except to this machine, where a local test receiver lives. */
export function validateWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RangeError("that is not a web address");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new RangeError("the alert address must start with https://");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RangeError("put credentials in the address path, not before the host");
  }
  if (url.href.length > 2048) throw new RangeError("that address is too long");
  return url.href;
}

export class AlertsRepository {
  readonly #db: Db;
  /** Absent in a self-hosted gateway with no accounts; the address then comes from the environment. */
  readonly #masterKey: Buffer | undefined;

  constructor(db: Db, masterKey?: Buffer) {
    this.#db = db;
    this.#masterKey = masterKey;
  }

  /**
   * Record an alert, unless one with the same key already exists.
   *
   * Returns the new alert, or `undefined` when it was a duplicate. The check
   * and the insert are one statement, so two calls racing to raise the same
   * alert cannot both win.
   */
  raise(tenantId: string, input: AlertInput, at = Date.now()): StoredAlert | undefined {
    const id = randomUUID();
    const result = this.#db
      .prepare(
        `INSERT INTO alerts (id, tenant_id, kind, dedupe_key, subject, message, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
      )
      .run(id, tenantId, input.kind, input.dedupeKey, input.subject, input.message, at);
    if (result.changes === 0) return undefined;
    return {
      ...input,
      id,
      tenantId,
      occurredAt: at,
      deliveredAt: null,
      attempts: 0,
      lastError: null,
    };
  }

  markDelivered(id: string, at = Date.now()): void {
    this.#db
      .prepare("UPDATE alerts SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?")
      .run(at, id);
  }

  markFailed(id: string, error: string): void {
    this.#db
      .prepare("UPDATE alerts SET attempts = attempts + 1, last_error = ? WHERE id = ?")
      .run(error.slice(0, 500), id);
  }

  recent(tenantId: string, limit = 50): StoredAlert[] {
    const rows = this.#db
      .prepare(
        `SELECT id, tenant_id AS tenantId, kind, dedupe_key AS dedupeKey, subject, message,
                occurred_at AS occurredAt, delivered_at AS deliveredAt, attempts,
                last_error AS lastError
         FROM alerts WHERE tenant_id = ? ORDER BY occurred_at DESC LIMIT ?`,
      )
      .all(tenantId, Math.max(1, Math.min(limit, 500))) as StoredAlert[];
    return rows;
  }

  settings(tenantId: string): AlertSettings {
    const row = this.#db
      .prepare(
        `SELECT encrypted_webhook AS encrypted, webhook_hint AS hint, desktop
         FROM alert_settings WHERE tenant_id = ?`,
      )
      .get(tenantId) as { encrypted: string | null; hint: string | null; desktop: number } | undefined;
    return {
      webhookConfigured: row?.encrypted != null,
      webhookHint: row?.hint ?? null,
      // On by default: someone running the desktop app is the person to tell.
      desktop: row === undefined ? true : row.desktop === 1,
    };
  }

  /** The decrypted address, for sending. Never returned to a browser. */
  webhookUrl(tenantId: string): string | undefined {
    if (this.#masterKey === undefined) return undefined;
    const row = this.#db
      .prepare("SELECT encrypted_webhook AS encrypted FROM alert_settings WHERE tenant_id = ?")
      .get(tenantId) as { encrypted: string | null } | undefined;
    if (row?.encrypted == null) return undefined;
    return decryptSecret(row.encrypted, this.#masterKey);
  }

  /**
   * Change where alerts go.
   *
   * `webhookUrl: null` removes the address; leaving it out keeps the current
   * one, so switching desktop notifications does not require re-entering a
   * secret the screen can no longer show.
   */
  configure(
    tenantId: string,
    change: { webhookUrl?: string | null; desktop?: boolean },
    at = Date.now(),
  ): AlertSettings {
    const current = this.#db
      .prepare(
        `SELECT encrypted_webhook AS encrypted, webhook_hint AS hint, desktop
         FROM alert_settings WHERE tenant_id = ?`,
      )
      .get(tenantId) as { encrypted: string | null; hint: string | null; desktop: number } | undefined;

    let encrypted = current?.encrypted ?? null;
    let hint = current?.hint ?? null;
    if (change.webhookUrl === null) {
      encrypted = null;
      hint = null;
    } else if (change.webhookUrl !== undefined) {
      if (this.#masterKey === undefined) {
        throw new Error("alert addresses can only be stored when a master key is configured");
      }
      const url = validateWebhookUrl(change.webhookUrl);
      encrypted = encryptSecret(url, this.#masterKey);
      hint = `${new URL(url).host}/…${maskSecret(url).slice(-4)}`;
    }
    const desktop = change.desktop ?? (current === undefined ? true : current.desktop === 1);

    this.#db
      .prepare(
        `INSERT INTO alert_settings (tenant_id, encrypted_webhook, webhook_hint, desktop, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET
           encrypted_webhook = excluded.encrypted_webhook,
           webhook_hint = excluded.webhook_hint,
           desktop = excluded.desktop,
           updated_at = excluded.updated_at`,
      )
      .run(tenantId, encrypted, hint, desktop ? 1 : 0, at);
    return this.settings(tenantId);
  }
}
