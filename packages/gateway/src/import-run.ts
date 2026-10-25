import type { Provider } from "@costgrid/core";
import type {
  AuditActor,
  AuditLog,
  ImportedRow,
  ImportOrigin,
  ImportsRepository,
  ImportWindow,
  KeyFactsRepository,
  SourceRef,
  SourcesRepository,
} from "@costgrid/db";
import type { ImportResult } from "./importers/index.js";
import type { SourceDirectory } from "./importers/names.js";

/**
 * One import, start to finish, the same way whoever asked for it.
 *
 * The one-off backfill, a connected admin key, an uploaded usage file and the
 * background sync all end the same way: a run is opened, the provider's rows
 * replace what was held for those days, the sources they came from are
 * recorded, and the run is closed as done or failed. Doing that in one place
 * keeps the four from drifting apart, and keeps the one rule that matters
 * most in one place too: a recorded error never contains the admin key.
 */

export interface ImportRunDeps {
  readonly imports: ImportsRepository;
  readonly sources: SourcesRepository;
  /** Where key facts from the provider's key lists go; absent, they are not kept. */
  readonly keyFacts?: KeyFactsRepository | undefined;
}

export type AuditDetail = Readonly<Record<string, string | number | boolean | null>>;

export interface ImportRunRequest {
  readonly tenantId: string;
  readonly provider: Provider;
  readonly origin: ImportOrigin;
  readonly window: ImportWindow;
  /** Fetches or parses the usage. Called after the run is opened, so a failure is kept. */
  readonly load: () => Promise<ImportResult>;
  /** The provider's names for sources, and its key facts. Best effort; only asked once the usage loaded. */
  readonly directory?: () => Promise<SourceDirectory>;
  /** What must never appear in a recorded or returned error: the admin key. */
  readonly secret?: string;
  /** Written once the rows are in. The detail gains the window and the row count. */
  readonly audit?: {
    readonly log: AuditLog;
    readonly actor: AuditActor;
    readonly action: string;
    readonly detail?: AuditDetail;
  };
}

export interface ImportRunOutcome {
  readonly rowsWritten: number;
  /** How many sources (keys, workspaces, projects or the account) the rows came from. */
  readonly sources: number;
  readonly unpricedModels: string[];
  readonly fromDay: string;
  readonly toDay: string;
}

/** An import that failed. The message is already safe to record and to show. */
export class ImportRunError extends Error {
  override readonly name = "ImportRunError";
}

/** Long enough for "invalid admin key"; short enough that a provider cannot dump a page. */
const MAX_ERROR_CHARS = 200;
/** Anything shaped like a provider key, whoever's it is. */
const KEY_LIKE = /\bsk-[A-Za-z0-9_-]{6,}/g;

/**
 * An error message with any key taken out and the length capped.
 *
 * A provider that echoes the credential back in its error ("invalid x-api-key
 * sk-ant-…") would otherwise put the key in the database and on the screen.
 */
export function safeErrorMessage(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (secret !== undefined && secret !== "") message = message.split(secret).join("[key]");
  message = message.replace(KEY_LIKE, "[key]").replace(/\s+/g, " ").trim();
  if (message.length > MAX_ERROR_CHARS) message = `${message.slice(0, MAX_ERROR_CHARS - 1)}…`;
  return message === "" ? "unknown error" : message;
}

/** The first and last day each source has rows on, so a source's range is its own. */
function daysBySource(rows: readonly ImportedRow[]): Map<string, { first: string; last: string }> {
  const days = new Map<string, { first: string; last: string }>();
  for (const row of rows) {
    const key = `${row.sourceKind ?? "account"}\u0000${row.sourceId ?? ""}`;
    const seen = days.get(key);
    if (!seen) days.set(key, { first: row.day, last: row.day });
    else {
      if (row.day < seen.first) seen.first = row.day;
      if (row.day > seen.last) seen.last = row.day;
    }
  }
  return days;
}

function recordSources(
  sources: SourcesRepository,
  tenantId: string,
  refs: readonly SourceRef[],
  rows: readonly ImportedRow[],
  window: ImportWindow,
  labels: ReadonlyMap<string, string>,
): void {
  const days = daysBySource(rows);
  for (const ref of refs) {
    const label = ref.label ?? labels.get(ref.id);
    // The workspace's or project's name, so this key can be matched to the
    // same key named in a usage file.
    const parentLabel = ref.parentLabel ?? (ref.parentId === undefined ? undefined : labels.get(ref.parentId));
    const range = days.get(`${ref.kind}\u0000${ref.kind === "account" ? "" : ref.id}`) ?? {
      first: window.fromDay,
      last: window.toDay,
    };
    sources.upsertSources(
      tenantId,
      [{ ...ref, ...(label !== undefined ? { label } : {}), ...(parentLabel !== undefined ? { parentLabel } : {}) }],
      range,
    );
  }
}

/**
 * Run one import and record it. Throws `ImportRunError` with a safe message on
 * failure, after marking the run failed; nothing of the import is kept then.
 */
export async function runImport(deps: ImportRunDeps, request: ImportRunRequest): Promise<ImportRunOutcome> {
  const { imports, sources } = deps;
  const { tenantId, provider, origin, window } = request;
  const runId = imports.startRun(tenantId, provider, window.fromDay, window.toDay, origin);

  let outcome: ImportRunOutcome;
  try {
    const result = await request.load();
    const directory = request.directory ? await request.directory().catch(() => null) : null;
    const rowsWritten = imports.putRows(tenantId, provider, window, result.rows, origin);
    recordSources(sources, tenantId, result.sources, result.rows, window, directory?.labels ?? new Map());
    if (directory?.keys && deps.keyFacts) {
      try {
        deps.keyFacts.replace(tenantId, provider, directory.keys);
      } catch {
        // Best effort, like the names: the usage import stands without them.
      }
    }
    imports.finishRun(runId, rowsWritten);
    outcome = {
      rowsWritten,
      sources: result.sources.length,
      unpricedModels: result.unpricedModels,
      fromDay: window.fromDay,
      toDay: window.toDay,
    };
  } catch (error) {
    const message = safeErrorMessage(error, request.secret);
    imports.failRun(runId, message);
    throw new ImportRunError(message);
  }

  if (request.audit) {
    const { log, actor, action, detail } = request.audit;
    log.record(tenantId, {
      actor,
      action,
      subject: provider,
      detail: { ...detail, fromDay: outcome.fromDay, toDay: outcome.toDay, rowsWritten: outcome.rowsWritten },
    });
  }
  return outcome;
}
