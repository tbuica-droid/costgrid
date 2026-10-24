import { randomUUID } from "node:crypto";
import type { Nanodollars, Provider, TokenUsage } from "@costgrid/core";
import type { Db } from "./database.js";
import type { TimeRange } from "./analytics.js";
import type { SourceKind } from "./sources.js";

/**
 * Historical usage pulled from a provider's admin API or a usage file.
 *
 * Kept strictly apart from metered calls. A provider report is a daily
 * aggregate assembled by someone else; a metered call is a request we watched
 * go past. They deserve different confidence, so they never share a table and
 * the UI never merges them into one number without saying so.
 */

export interface ImportedRow {
  readonly provider: Provider;
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly requests: number;
  /** Our catalog's price for these tokens. */
  readonly costCatalog: Nanodollars;
  readonly priced: boolean;
  /** The provider's own figure, where it reported one. */
  readonly costReported?: Nanodollars | undefined;
  /** Where the usage came from. The whole account when omitted. */
  readonly sourceKind?: SourceKind | undefined;
  /** The key, workspace or project id; '' for the account. */
  readonly sourceId?: string | undefined;
}

/** How a run's rows arrived: pulled with an admin key, or read from a file. */
export type ImportOrigin = "admin-api" | "csv";

/** An inclusive range of UTC days, YYYY-MM-DD, that an import covers. */
export interface ImportWindow {
  readonly fromDay: string;
  readonly toDay: string;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ImportSummary {
  readonly provider: Provider;
  readonly fromDay: string;
  readonly toDay: string;
  readonly rowsWritten: number;
  readonly totalCatalogCost: Nanodollars;
  readonly totalReportedCost: Nanodollars | undefined;
  readonly unpricedModels: readonly string[];
}

export interface ImportedDailyPoint {
  readonly day: string;
  readonly cost: Nanodollars;
  readonly requests: number;
}

export interface ImportedGroup {
  readonly key: string;
  readonly cost: Nanodollars;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class ImportsRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  startRun(
    tenantId: string,
    provider: Provider,
    fromDay: string,
    toDay: string,
    origin: ImportOrigin,
  ): string {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO import_runs (id, tenant_id, provider, started_at, from_day, to_day, status, origin)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, tenantId, provider, Date.now(), fromDay, toDay, origin);
    return id;
  }

  finishRun(id: string, rowsWritten: number): void {
    this.#db
      .prepare("UPDATE import_runs SET finished_at = ?, rows_written = ?, status = 'ok' WHERE id = ?")
      .run(Date.now(), rowsWritten, id);
  }

  failRun(id: string, message: string): void {
    this.#db
      .prepare(
        "UPDATE import_runs SET finished_at = ?, status = 'error', error_message = ? WHERE id = ?",
      )
      .run(Date.now(), message.slice(0, 500), id);
  }

  /**
   * Replace what is held for one provider over a window of days.
   *
   * Everything already stored for that provider with a day inside the window
   * goes, then the new rows go in, in one transaction. Replacing rather than
   * upserting is what keeps two shapes of the same usage from adding up: rows
   * imported before sources existed were summed across every key, and the
   * same days re-imported per key would otherwise be counted twice. It also
   * means a key or model that vanished from a restated day really vanishes.
   *
   * A row dated outside the window widens it: the provider answered for that
   * day, so its answer replaces what was held rather than adding to it. A row
   * for another provider is a caller's mistake, and nothing is written.
   */
  putRows(
    tenantId: string,
    provider: Provider,
    window: ImportWindow,
    rows: readonly ImportedRow[],
    origin: ImportOrigin,
  ): number {
    let { fromDay, toDay } = window;
    if (!DAY_PATTERN.test(fromDay) || !DAY_PATTERN.test(toDay) || fromDay > toDay) {
      throw new RangeError(`not a window of days: ${fromDay} to ${toDay}`);
    }
    for (const row of rows) {
      if (row.provider !== provider) {
        throw new RangeError(`a ${row.provider} row cannot be written as ${provider} usage`);
      }
      if (!DAY_PATTERN.test(row.day)) throw new RangeError(`not a day: ${row.day}`);
      if (row.day < fromDay) fromDay = row.day;
      if (row.day > toDay) toDay = row.day;
    }

    const clear = this.#db.prepare(
      "DELETE FROM imported_usage WHERE tenant_id = ? AND provider = ? AND day >= ? AND day <= ?",
    );
    // The window was just emptied, so a conflict means the caller passed the
    // same key twice; the last one wins rather than failing the whole import.
    const insert = this.#db.prepare(
      `INSERT INTO imported_usage (
         id, tenant_id, provider, day, model, source_kind, source_id, origin,
         input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
         cache_read_tokens, requests, cost_catalog, priced, cost_reported, imported_at
       ) VALUES (
         @id, @tenantId, @provider, @day, @model, @sourceKind, @sourceId, @origin,
         @inputTokens, @outputTokens, @cacheWrite5m, @cacheWrite1h,
         @cacheRead, @requests, @costCatalog, @priced, @costReported, @importedAt
       )
       ON CONFLICT (tenant_id, provider, day, model, source_kind, source_id) DO UPDATE SET
         origin                = excluded.origin,
         input_tokens          = excluded.input_tokens,
         output_tokens         = excluded.output_tokens,
         cache_write_5m_tokens = excluded.cache_write_5m_tokens,
         cache_write_1h_tokens = excluded.cache_write_1h_tokens,
         cache_read_tokens     = excluded.cache_read_tokens,
         requests              = excluded.requests,
         cost_catalog          = excluded.cost_catalog,
         priced                = excluded.priced,
         cost_reported         = excluded.cost_reported,
         imported_at           = excluded.imported_at`,
    );

    const now = Date.now();
    this.#db.transaction(() => {
      clear.run(tenantId, provider, fromDay, toDay);
      for (const row of rows) {
        const sourceKind = row.sourceKind ?? "account";
        insert.run({
          id: randomUUID(),
          tenantId,
          provider,
          day: row.day,
          model: row.model,
          sourceKind,
          sourceId: sourceKind === "account" ? "" : (row.sourceId ?? ""),
          origin,
          inputTokens: row.usage.inputTokens,
          outputTokens: row.usage.outputTokens,
          cacheWrite5m: row.usage.cacheWrite5mTokens,
          cacheWrite1h: row.usage.cacheWrite1hTokens,
          cacheRead: row.usage.cacheReadTokens,
          requests: row.requests,
          costCatalog: row.costCatalog,
          priced: row.priced ? 1 : 0,
          costReported: row.costReported ?? null,
          importedAt: now,
        });
      }
    })();

    return rows.length;
  }

  /** Whether this tenant has any imported history at all. */
  hasImports(tenantId: string): boolean {
    const row = this.#db
      .prepare("SELECT 1 AS present FROM imported_usage WHERE tenant_id = ? LIMIT 1")
      .get(tenantId) as { present: number } | undefined;
    return row !== undefined;
  }

  summary(tenantId: string, range: TimeRange) {
    const { fromDay, toDay } = dayBounds(range);
    const row = this.#db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_catalog), 0)                                AS catalogCost,
           COALESCE(SUM(cost_reported), 0)                               AS reportedCost,
           COALESCE(SUM(CASE WHEN cost_reported IS NULL THEN 0 ELSE 1 END), 0) AS reportedRows,
           COALESCE(SUM(requests), 0)                                    AS requests,
           COALESCE(SUM(input_tokens), 0)                                AS inputTokens,
           COALESCE(SUM(output_tokens), 0)                               AS outputTokens,
           COALESCE(SUM(cache_read_tokens), 0)                           AS cacheReadTokens,
           COALESCE(SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END), 0)      AS unpricedRows,
           COUNT(*)                                                      AS rows
         FROM imported_usage
         WHERE tenant_id = ? AND day >= ? AND day <= ?`,
      )
      .safeIntegers(true)
      .get(tenantId, fromDay, toDay) as Record<string, bigint>;

    const inputTokens = Number(row["inputTokens"]);
    const cacheReadTokens = Number(row["cacheReadTokens"]);
    const readable = inputTokens + cacheReadTokens;

    return {
      rows: Number(row["rows"]),
      requests: Number(row["requests"]),
      inputTokens,
      outputTokens: Number(row["outputTokens"]),
      cacheReadTokens,
      cacheHitRatio: readable === 0 ? 0 : cacheReadTokens / readable,
      catalogCost: row["catalogCost"]!,
      // Only meaningful when the provider actually reported figures.
      reportedCost: Number(row["reportedRows"]) > 0 ? row["reportedCost"]! : undefined,
      unpricedRows: Number(row["unpricedRows"]),
    };
  }

  dailyCost(tenantId: string, range: TimeRange): ImportedDailyPoint[] {
    const { fromDay, toDay } = dayBounds(range);
    const rows = this.#db
      .prepare(
        `SELECT day,
                COALESCE(SUM(COALESCE(cost_reported, cost_catalog)), 0) AS cost,
                COALESCE(SUM(requests), 0)                              AS requests
         FROM imported_usage
         WHERE tenant_id = ? AND day >= ? AND day <= ?
         GROUP BY day ORDER BY day`,
      )
      .safeIntegers(true)
      .all(tenantId, fromDay, toDay) as { day: string; cost: bigint; requests: bigint }[];

    return rows.map((r) => ({ day: r.day, cost: r.cost, requests: Number(r.requests) }));
  }

  byModel(tenantId: string, range: TimeRange): ImportedGroup[] {
    const { fromDay, toDay } = dayBounds(range);
    const rows = this.#db
      .prepare(
        `SELECT model AS key,
                COALESCE(SUM(COALESCE(cost_reported, cost_catalog)), 0) AS cost,
                COALESCE(SUM(requests), 0)                              AS requests,
                COALESCE(SUM(input_tokens), 0)                          AS inputTokens,
                COALESCE(SUM(output_tokens), 0)                         AS outputTokens
         FROM imported_usage
         WHERE tenant_id = ? AND day >= ? AND day <= ?
         GROUP BY model ORDER BY cost DESC`,
      )
      .safeIntegers(true)
      .all(tenantId, fromDay, toDay) as Record<string, bigint | string>[];

    return rows.map((r) => ({
      key: r["key"] as string,
      cost: r["cost"] as bigint,
      requests: Number(r["requests"]),
      inputTokens: Number(r["inputTokens"]),
      outputTokens: Number(r["outputTokens"]),
    }));
  }

  recentRuns(tenantId: string, limit = 10) {
    return this.#db
      .prepare(
        `SELECT id, provider, origin, started_at AS startedAt, finished_at AS finishedAt,
                from_day AS fromDay, to_day AS toDay, rows_written AS rowsWritten,
                status, error_message AS errorMessage
         FROM import_runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .all(tenantId, limit) as {
      id: string;
      provider: string;
      origin: ImportOrigin;
      startedAt: number;
      finishedAt: number | null;
      fromDay: string;
      toDay: string;
      rowsWritten: number;
      status: string;
      errorMessage: string | null;
    }[];
  }

  deleteAll(tenantId: string, provider?: Provider): number {
    return provider === undefined
      ? this.#db.prepare("DELETE FROM imported_usage WHERE tenant_id = ?").run(tenantId).changes
      : this.#db
          .prepare("DELETE FROM imported_usage WHERE tenant_id = ? AND provider = ?")
          .run(tenantId, provider).changes;
  }
}

/** A TimeRange is epoch ms; imported rows are keyed by UTC day string. */
export function dayBounds(range: TimeRange): { fromDay: string; toDay: string } {
  return { fromDay: toUtcDay(range.from), toDay: toUtcDay(range.to) };
}

export function toUtcDay(at: number | Date): string {
  return new Date(at).toISOString().slice(0, 10);
}
