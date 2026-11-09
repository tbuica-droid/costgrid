import type { Nanodollars } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * Work sent to a provider's batch API at half price.
 *
 * One row per batch: the provider's ids, where its results are kept, counts
 * and, once every result line has been priced, the cost. Never a request or an
 * answer: the provider holds those for its own retention period, and CostGrid
 * reads results only in memory, to price them and to pass them back.
 */

export type DeferredStatus = "in_progress" | "ended" | "failed" | "expired" | "canceled";

export const FINISHED_STATUSES: ReadonlySet<DeferredStatus> = new Set(["ended", "failed", "expired", "canceled"]);

export interface DeferredBatch {
  readonly id: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly department: string;
  readonly provider: string;
  readonly providerBatchId: string;
  readonly status: DeferredStatus;
  readonly requestCount: number;
  readonly succeededCount: number;
  readonly erroredCount: number;
  readonly resultsRef: string | null;
  readonly errorsRef: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: number;
  readonly checkedAt: number | null;
  readonly endedAt: number | null;
  readonly meteredAt: number | null;
  readonly cost: Nanodollars;
}

export interface DeferredStatusUpdate {
  readonly status: DeferredStatus;
  readonly succeededCount: number;
  readonly erroredCount: number;
  readonly resultsRef?: string | undefined;
  readonly errorsRef?: string | undefined;
  readonly endedAt?: number | undefined;
  readonly errorMessage?: string | undefined;
}

const COLUMNS = `id, tenant_id AS tenantId, agent_id AS agentId, department, provider,
  provider_batch_id AS providerBatchId, status, request_count AS requestCount,
  succeeded_count AS succeededCount, errored_count AS erroredCount,
  results_ref AS resultsRef, errors_ref AS errorsRef, error_message AS errorMessage,
  created_at AS createdAt, checked_at AS checkedAt, ended_at AS endedAt,
  metered_at AS meteredAt, cost_total AS cost`;

function row(raw: Record<string, unknown>): DeferredBatch {
  const n = (v: unknown): number | null => (v === null ? null : Number(v));
  return {
    id: raw["id"] as string,
    tenantId: raw["tenantId"] as string,
    agentId: raw["agentId"] as string,
    department: raw["department"] as string,
    provider: raw["provider"] as string,
    providerBatchId: raw["providerBatchId"] as string,
    status: raw["status"] as DeferredStatus,
    requestCount: Number(raw["requestCount"]),
    succeededCount: Number(raw["succeededCount"]),
    erroredCount: Number(raw["erroredCount"]),
    resultsRef: (raw["resultsRef"] as string | null) ?? null,
    errorsRef: (raw["errorsRef"] as string | null) ?? null,
    errorMessage: (raw["errorMessage"] as string | null) ?? null,
    createdAt: Number(raw["createdAt"]),
    checkedAt: n(raw["checkedAt"]),
    endedAt: n(raw["endedAt"]),
    meteredAt: n(raw["meteredAt"]),
    cost: BigInt(raw["cost"] as bigint),
  };
}

export class DeferredBatches {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(batch: {
    id: string;
    tenantId: string;
    agentId: string;
    department: string;
    provider: string;
    providerBatchId: string;
    status: DeferredStatus;
    requestCount: number;
    createdAt: number;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO deferred_batches
           (id, tenant_id, agent_id, department, provider, provider_batch_id, status, request_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batch.id,
        batch.tenantId,
        batch.agentId,
        batch.department,
        batch.provider,
        batch.providerBatchId,
        batch.status,
        batch.requestCount,
        batch.createdAt,
      );
  }

  /** Scoped to the tenant, so another organisation's id finds nothing. */
  get(tenantId: string, id: string): DeferredBatch | undefined {
    const raw = this.#db
      .prepare(`SELECT ${COLUMNS} FROM deferred_batches WHERE tenant_id = ? AND id = ?`)
      .safeIntegers(true)
      .get(tenantId, id) as Record<string, unknown> | undefined;
    return raw === undefined ? undefined : row(raw);
  }

  list(tenantId: string, agentId: string | undefined, limit = 100): DeferredBatch[] {
    return (
      this.#db
        .prepare(
          `SELECT ${COLUMNS} FROM deferred_batches
           WHERE tenant_id = ? ${agentId === undefined ? "" : "AND agent_id = ?"}
           ORDER BY created_at DESC LIMIT ?`,
        )
        .safeIntegers(true)
        .all(...(agentId === undefined ? [tenantId, limit] : [tenantId, agentId, limit])) as Record<string, unknown>[]
    ).map(row);
  }

  /** Batches still to be checked or priced, oldest first, across every tenant. */
  pending(limit = 200): DeferredBatch[] {
    return (
      this.#db
        .prepare(`SELECT ${COLUMNS} FROM deferred_batches WHERE metered_at IS NULL ORDER BY created_at LIMIT ?`)
        .safeIntegers(true)
        .all(limit) as Record<string, unknown>[]
    ).map(row);
  }

  updateStatus(id: string, update: DeferredStatusUpdate, at: number): void {
    this.#db
      .prepare(
        `UPDATE deferred_batches
         SET status = ?, succeeded_count = ?, errored_count = ?,
             results_ref = COALESCE(?, results_ref), errors_ref = COALESCE(?, errors_ref),
             ended_at = COALESCE(?, ended_at), error_message = COALESCE(?, error_message),
             checked_at = ?
         WHERE id = ?`,
      )
      .run(
        update.status,
        update.succeededCount,
        update.erroredCount,
        update.resultsRef ?? null,
        update.errorsRef ?? null,
        update.endedAt ?? null,
        update.errorMessage ?? null,
        at,
        id,
      );
  }

  /**
   * Claim a finished batch for pricing. True for exactly one caller, so two
   * sweeps (or a sweep and a status read) never record its calls twice.
   */
  claimForMetering(id: string, at: number): boolean {
    return (
      this.#db
        .prepare("UPDATE deferred_batches SET metered_at = ? WHERE id = ? AND metered_at IS NULL")
        .run(at, id).changes === 1
    );
  }


  setCost(id: string, cost: Nanodollars): void {
    this.#db.prepare("UPDATE deferred_batches SET cost_total = ? WHERE id = ?").run(cost, id);
  }
}
