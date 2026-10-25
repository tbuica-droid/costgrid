import type { Provider } from "@costgrid/core";
import {
  type AdminKeyMeta,
  type AuditLog,
  type ImportsRepository,
  type KeyFactsRepository,
  type SourcesRepository,
  SYSTEM_ACTOR,
  toUtcDay,
} from "@costgrid/db";
import type { Alerter } from "./alerts.js";
import { explainImportError } from "./connect-copy.js";
import { ImportRunError, runImport, safeErrorMessage } from "./import-run.js";
import { importerFor } from "./importers/index.js";
import { fetchSourceDirectory } from "./importers/names.js";
import { adminKeyAccount, type SecretStore } from "./secret-store.js";

/**
 * Keeping imported usage current with the admin keys the owner chose to keep.
 *
 * Every few hours each stored key that has not expired is read back from the
 * keychain and used to import the days since its last good sync, with a few
 * days of overlap because providers restate recent days. The key is held for
 * the length of one import and goes nowhere else; what is recorded is whether
 * it worked and, if not, a short message with any key taken out.
 *
 * The expiry the owner picked is enforced here: an expired key is not used,
 * even though the provider might still accept it. Before that, the owner is
 * reminded two weeks ahead, three days ahead and on the day.
 */

const DAY_MS = 86_400_000;
/** Providers restate recent days; re-reading a few keeps the figures matching the invoice. */
const OVERLAP_MS = 3 * DAY_MS;
const MAX_WINDOW_MS = 90 * DAY_MS;
/** Days before expiry at which the owner is reminded, most urgent last. */
const REMINDERS = [14, 3, 0] as const;

const NAMES: Partial<Record<Provider, string>> = { anthropic: "Claude", openai: "OpenAI" };

export interface SyncLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface AdminKeySyncDeps {
  readonly imports: ImportsRepository;
  readonly sources: SourcesRepository;
  readonly keyFacts?: KeyFactsRepository | undefined;
  readonly secretStore: SecretStore;
  /** Where expiry reminders go. Absent, nobody is reminded. */
  readonly alerter?: Alerter | undefined;
  readonly audit?: AuditLog | undefined;
  readonly log: SyncLog;
  /** Overridable so tests never reach a real provider. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: () => number;
}

export interface SyncSummary {
  readonly synced: number;
  readonly failed: number;
  readonly skipped: number;
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Which reminder is due, if any: the most urgent threshold already reached. */
export function reminderDue(expiresAt: number, now: number): (typeof REMINDERS)[number] | undefined {
  const left = expiresAt - now;
  let due: (typeof REMINDERS)[number] | undefined;
  for (const days of REMINDERS) if (left <= days * DAY_MS) due = days;
  return due;
}

export class AdminKeySync {
  readonly #deps: AdminKeySyncDeps;
  readonly #now: () => number;
  #running: Promise<SyncSummary> | undefined;

  constructor(deps: AdminKeySyncDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Sync every stored key. One run at a time: a call while one is in
   * progress gets that run's result rather than starting a second.
   */
  syncAll(): Promise<SyncSummary> {
    this.#running ??= this.#syncAll().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #syncAll(): Promise<SyncSummary> {
    let synced = 0;
    let failed = 0;
    let skipped = 0;
    for (const key of this.#deps.sources.allAdminKeys()) {
      const now = this.#now();
      if ((key.expiresAt !== null && key.expiresAt <= now) || !importerFor(key.provider)) {
        skipped++;
        continue;
      }
      if (await this.#syncOne(key, now)) synced++;
      else failed++;
    }
    return { synced, failed, skipped };
  }

  async #syncOne(key: AdminKeyMeta & { tenantId: string }, now: number): Promise<boolean> {
    const { imports, sources, secretStore, log, audit } = this.#deps;
    const { tenantId, provider } = key;
    const fail = (message: string): false => {
      sources.recordSync(tenantId, provider, false, message);
      log.warn({ tenantId, provider, error: message }, "admin key sync failed");
      return false;
    };

    let adminKey: string | undefined;
    try {
      adminKey = await secretStore.get(adminKeyAccount(tenantId, provider));
    } catch {
      return fail("the keychain could not be read");
    }
    if (adminKey === undefined || adminKey === "") return fail("key missing from keychain");

    // From the last good sync, less the overlap; a key that never synced, or
    // last failed, goes back the full 90 days.
    const since = key.lastSyncStatus === "ok" && key.lastSyncAt !== null ? key.lastSyncAt - OVERLAP_MS : 0;
    const from = new Date(Math.max(since, now - MAX_WINDOW_MS));
    const to = new Date(now);
    const doFetch = this.#deps.fetchImpl ?? fetch;
    const secret = adminKey;

    try {
      const outcome = await runImport(
        { imports, sources, keyFacts: this.#deps.keyFacts },
        {
          tenantId,
          provider,
          origin: "admin-api",
          window: { fromDay: toUtcDay(from), toDay: toUtcDay(to) },
          secret,
          load: () => importerFor(provider)!.run({ apiKey: secret, from, to, fetchImpl: doFetch }),
          directory: () => fetchSourceDirectory(provider, secret, doFetch),
          ...(audit
            ? {
                audit: {
                  log: audit,
                  actor: SYSTEM_ACTOR,
                  action: "import.synced",
                  detail: { origin: "admin-api" },
                },
              }
            : {}),
        },
      );
      sources.recordSync(tenantId, provider, true);
      log.info({ tenantId, provider, rowsWritten: outcome.rowsWritten }, "admin key sync finished");
      return true;
    } catch (error) {
      // What the owner reads on the Setup screen, so said the way they need it.
      return fail(explainImportError(provider, error instanceof ImportRunError ? error.message : safeErrorMessage(error, secret)));
    }
  }

  /**
   * Remind owners of keys about to expire: at 14 days, 3 days and on or after
   * the day. Each reminder is raised once per key and expiry, so a key
   * replaced with a new expiry starts its reminders again.
   */
  remindExpiring(now = this.#now()): void {
    const { alerter, sources } = this.#deps;
    if (alerter === undefined) return;
    for (const key of sources.allAdminKeys()) {
      if (key.expiresAt === null) continue;
      const due = reminderDue(key.expiresAt, now);
      if (due === undefined) continue;

      const name = NAMES[key.provider] ?? key.provider;
      const date = formatDate(key.expiresAt);
      alerter.raise(
        key.tenantId,
        {
          kind: "key-expiring",
          dedupeKey: `key-expiring:${key.provider}:${key.expiresAt}:${due}`,
          subject: key.provider,
          message:
            due === 0
              ? `Your ${name} admin key expired on ${date}, so CostGrid has stopped importing ` +
                `${name} usage with it. Connect a new key or upload a usage file to keep costs current.`
              : `Your ${name} admin key expires on ${date}. After that CostGrid stops using it; ` +
                "connect a new key before then to keep costs current.",
        },
        now,
      );
    }
  }
}
