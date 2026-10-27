import { Analytics, type Db, RunOutcomes } from "@costgrid/db";

/**
 * The console's slowest reads, by name, so they can run on another thread.
 *
 * better-sqlite3 is synchronous: while a query runs, nothing else in the
 * process does, including forwarding customers' calls. On 200,000 calls a
 * month the outcomes report took seconds and the agent map most of one.
 * Run in a worker with its own read-only connection (WAL lets it read while
 * the gateway writes), they no longer stall the proxy.
 *
 * Each task takes the database first and returns plain data, which is what
 * can cross between threads.
 */
export const READ_TASKS = {
  outcomes: (db: Db, tenantId: string, range: { from: number; to: number }, asOf: number) =>
    new RunOutcomes(db).forTenant(tenantId, range, asOf),
  topology: (db: Db, tenantId: string, range: { from: number; to: number }) => new Analytics(db).topology(tenantId, range),
  agentDetail: (db: Db, tenantId: string, range: { from: number; to: number }) =>
    new Analytics(db).agentDetail(tenantId, range),
};

export type ReadTaskName = keyof typeof READ_TASKS;
type Rest<F> = F extends (db: Db, ...rest: infer A) => unknown ? A : never;
export type ReadTaskArgs<N extends ReadTaskName> = Rest<(typeof READ_TASKS)[N]>;
export type ReadTaskResult<N extends ReadTaskName> = ReturnType<(typeof READ_TASKS)[N]>;
