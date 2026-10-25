import { AuditLog, type AuditActor, SYSTEM_ACTOR } from "./audit.js";
import type { Db } from "./database.js";

/**
 * How long CostGrid keeps what it records, and how it forgets.
 *
 * Every buyer with a compliance function asks two questions about data: what
 * do you store, and when does it go away. The first already had an answer.
 * This is the second.
 *
 * ## Keeping forever is the default, deliberately
 *
 * Zero means no limit, and zero is what an organisation that never opens this
 * page gets. Deleting a customer's cost history because nobody configured a
 * policy would be the worst available default: the loss is silent, permanent,
 * and lands on the person who trusted the defaults most.
 *
 * ## Three windows, not one
 *
 * They answer to different people and a single number would force the
 * shortest of the three onto all of them.
 *
 * - **Call detail** is operational. It is also the bulk of the database and
 *   the most granular thing stored, so it is usually the first anyone wants
 *   capped.
 * - **Enforcement history** is what a budget owner argues from months later.
 * - **The audit log** is evidence, and is handled separately below.
 *
 * ## The audit log is not purged by the scheduler
 *
 * `purge()` deliberately leaves it alone even when `auditDays` is set. An
 * automatic job that erases evidence on a timer is indistinguishable, from the
 * outside, from someone erasing evidence, and a retention setting is a
 * plausible way to do exactly that. Removing audit entries takes a deliberate
 * command from a person, and writes a record of itself into the chain it is
 * cutting. See `AuditLog.purgeBefore`.
 */

export interface RetentionSettings {
  /** Days of per-call detail to keep. Zero keeps everything. */
  readonly callDays: number;
  /** Days of rule firings to keep. Zero keeps everything. */
  readonly eventDays: number;
  /** Days of audit log to keep. Zero keeps everything; otherwise 365 or more. */
  readonly auditDays: number;
  readonly updatedAt: number;
}

export interface PurgeResult {
  readonly calls: number;
  readonly toolInvocations: number;
  readonly outcomes: number;
  readonly importedUsage: number;
  readonly violations: number;
  /** Total rows removed, for the one-line summary. */
  readonly total: number;
  readonly ranAt: number;
}

export interface ErasureResult {
  /** Rows removed per table, for the confirmation an erasure request needs. */
  readonly tables: Readonly<Record<string, number>>;
  readonly total: number;
  readonly erasedAt: number;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  callDays: 0,
  eventDays: 0,
  auditDays: 0,
  updatedAt: 0,
};

/** The shortest an audit window may be. Anything less is not an audit trail. */
export const MIN_AUDIT_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every table holding tenant data, with the column that scopes it.
 *
 * Kept as one list so erasure cannot quietly miss a table added later. A new
 * table with a `tenant_id` that is not named here is a bug, and
 * `tablesMissingFromErasure` finds it.
 */
const TENANT_TABLES = [
  "calls",
  "violations",
  "tool_invocations",
  "tool_grants",
  "outcomes",
  "imported_usage",
  "import_runs",
  "agent_person_cost",
  "agent_job_counts",
  "agents",
  "policies",
  "api_keys",
  "rate_overrides",
  "provider_credentials",
  "subscriptions",
  "memberships",
  "autopilot",
  "autopilot_actions",
  "retention",
  "sso_connections",
  "sso_requests",
  "audit_log",
  "alert_settings",
  "alerts",
  "fixed_costs",
  "admin_keys",
  "usage_sources",
  "outcome_settings",
  // The local copies only. Anchors already delivered live at the receiver,
  // which is the point of them, and are outside anything this can reach.
  "anchors",
] as const;

export class Retention {
  readonly #db: Db;
  readonly #audit: AuditLog;

  constructor(db: Db) {
    this.#db = db;
    this.#audit = new AuditLog(db);
  }

  settingsOf(tenantId: string): RetentionSettings {
    const row = this.#db
      .prepare(
        `SELECT call_days AS callDays, event_days AS eventDays,
                audit_days AS auditDays, updated_at AS updatedAt
         FROM retention WHERE tenant_id = ?`,
      )
      .get(tenantId) as RetentionSettings | undefined;
    return row ?? DEFAULT_RETENTION;
  }

  /**
   * Change the policy, and record who changed it.
   *
   * Shortening a window is a destructive decision taken in advance, so it is
   * one of the events the audit log exists for.
   */
  set(
    tenantId: string,
    next: {
      callDays?: number | undefined;
      eventDays?: number | undefined;
      auditDays?: number | undefined;
    },
    actor: AuditActor = SYSTEM_ACTOR,
    now = Date.now(),
  ): RetentionSettings {
    const current = this.settingsOf(tenantId);
    const settings: RetentionSettings = {
      callDays: next.callDays ?? current.callDays,
      eventDays: next.eventDays ?? current.eventDays,
      auditDays: next.auditDays ?? current.auditDays,
      updatedAt: now,
    };

    for (const [field, value] of [
      ["callDays", settings.callDays],
      ["eventDays", settings.eventDays],
      ["auditDays", settings.auditDays],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new RangeError(`${field} must be a whole number of days, or 0 to keep everything`);
      }
    }
    if (settings.auditDays !== 0 && settings.auditDays < MIN_AUDIT_DAYS) {
      throw new RangeError(
        `audit history must be kept for at least ${MIN_AUDIT_DAYS} days, or 0 to keep it indefinitely`,
      );
    }

    this.#db
      .prepare(
        `INSERT INTO retention (tenant_id, call_days, event_days, audit_days, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET
           call_days  = excluded.call_days,
           event_days = excluded.event_days,
           audit_days = excluded.audit_days,
           updated_at = excluded.updated_at`,
      )
      .run(tenantId, settings.callDays, settings.eventDays, settings.auditDays, now);

    this.#audit.record(
      tenantId,
      {
        actor,
        action: "retention.changed",
        subject: tenantId,
        detail: {
          callDaysFrom: current.callDays,
          callDaysTo: settings.callDays,
          eventDaysFrom: current.eventDays,
          eventDaysTo: settings.eventDays,
          auditDaysFrom: current.auditDays,
          auditDaysTo: settings.auditDays,
        },
      },
      now,
    );

    return settings;
  }

  /**
   * Delete data that has aged out of the policy.
   *
   * Safe to run repeatedly and safe to run on a tenant with no policy, where
   * it does nothing. The audit log is not touched here; see the note at the
   * top of this file for why that is a decision rather than an omission.
   */
  purge(tenantId: string, now = Date.now()): PurgeResult {
    const settings = this.settingsOf(tenantId);
    const empty: PurgeResult = {
      calls: 0,
      toolInvocations: 0,
      outcomes: 0,
      importedUsage: 0,
      violations: 0,
      total: 0,
      ranAt: now,
    };
    if (settings.callDays === 0 && settings.eventDays === 0) return empty;

    const result = this.#db.transaction(() => {
      let calls = 0;
      let toolInvocations = 0;
      let outcomes = 0;
      let importedUsage = 0;
      let violations = 0;

      if (settings.callDays > 0) {
        const cutoff = now - settings.callDays * DAY_MS;
        calls = this.#db
          .prepare("DELETE FROM calls WHERE tenant_id = ? AND started_at < ?")
          .run(tenantId, cutoff).changes;
        toolInvocations = this.#db
          .prepare("DELETE FROM tool_invocations WHERE tenant_id = ? AND occurred_at < ?")
          .run(tenantId, cutoff).changes;
        outcomes = this.#db
          .prepare("DELETE FROM outcomes WHERE tenant_id = ? AND reported_at < ?")
          .run(tenantId, cutoff).changes;
        // Imported history is bucketed by UTC day, not by timestamp, so the
        // cutoff is compared as a day string against the same format.
        const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
        importedUsage = this.#db
          .prepare("DELETE FROM imported_usage WHERE tenant_id = ? AND day < ?")
          .run(tenantId, cutoffDay).changes;
      }

      if (settings.eventDays > 0) {
        const cutoff = now - settings.eventDays * DAY_MS;
        violations = this.#db
          .prepare("DELETE FROM violations WHERE tenant_id = ? AND occurred_at < ?")
          .run(tenantId, cutoff).changes;
      }

      return { calls, toolInvocations, outcomes, importedUsage, violations };
    })();

    const total =
      result.calls +
      result.toolInvocations +
      result.outcomes +
      result.importedUsage +
      result.violations;

    // Only worth an entry when something was actually removed. A daily job
    // that writes "deleted nothing" 365 times a year buries the entries that
    // matter.
    if (total > 0) {
      this.#audit.record(
        tenantId,
        {
          actor: SYSTEM_ACTOR,
          action: "retention.purged",
          subject: tenantId,
          detail: {
            calls: result.calls,
            toolInvocations: result.toolInvocations,
            outcomes: result.outcomes,
            importedUsage: result.importedUsage,
            violations: result.violations,
            callDays: settings.callDays,
            eventDays: settings.eventDays,
          },
        },
        now,
      );
    }

    return { ...result, total, ranAt: now };
  }

  /** Run `purge` for every tenant that has a policy. Returns what it removed. */
  purgeAll(now = Date.now()): Map<string, PurgeResult> {
    const tenants = this.#db
      .prepare(
        "SELECT tenant_id AS tenantId FROM retention WHERE call_days > 0 OR event_days > 0",
      )
      .all() as { tenantId: string }[];

    const results = new Map<string, PurgeResult>();
    for (const { tenantId } of tenants) {
      const result = this.purge(tenantId, now);
      if (result.total > 0) results.set(tenantId, result);
    }
    return results;
  }

  /**
   * Remove everything belonging to one organisation.
   *
   * This is the answer to a deletion request, and it is unrecoverable. It
   * takes the audit log with it, because an audit trail describing an
   * organisation is data about that organisation: keeping it back would defeat
   * the point of the request while looking like compliance.
   *
   * The counts are returned so the person who asked can be told what went,
   * which is usually what an erasure request actually needs to close.
   */
  eraseTenant(tenantId: string, now = Date.now()): ErasureResult {
    const tables: Record<string, number> = {};

    this.#db.transaction(() => {
      for (const table of TENANT_TABLES) {
        const changes = this.#db
          .prepare(`DELETE FROM ${table} WHERE tenant_id = ?`)
          .run(tenantId).changes;
        if (changes > 0) tables[table] = changes;
      }
      this.#db.prepare("DELETE FROM tenants WHERE id = ?").run(tenantId);
    })();

    const total = Object.values(tables).reduce((sum, n) => sum + n, 0);
    return { tables, total, erasedAt: now };
  }

  /**
   * Any table carrying a `tenant_id` that erasure does not cover.
   *
   * Erasure is only as complete as its list, and a list maintained by hand
   * goes stale the first time someone adds a table. A test asserts this is
   * empty, so the staleness is caught when the table is added rather than when
   * a customer asks for their data back.
   */
  tablesMissingFromErasure(): string[] {
    const known = new Set<string>(TENANT_TABLES);
    const rows = this.#db
      .prepare(
        `SELECT m.name AS tableName
         FROM sqlite_master m
         WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
      )
      .all() as { tableName: string }[];

    return rows
      .filter(({ tableName }) => {
        if (known.has(tableName)) return false;
        const columns = this.#db.prepare(`PRAGMA table_info(${tableName})`).all() as {
          name: string;
        }[];
        return columns.some((c) => c.name === "tenant_id");
      })
      .map((r) => r.tableName)
      .sort();
  }
}
