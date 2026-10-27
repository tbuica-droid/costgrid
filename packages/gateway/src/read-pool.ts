import { Worker } from "node:worker_threads";
import type { Db } from "@costgrid/db";
import { READ_TASKS, type ReadTaskArgs, type ReadTaskName, type ReadTaskResult } from "./read-tasks.js";

/**
 * The worker script beside this file: compiled JavaScript normally, the
 * TypeScript source when the gateway runs from source through tsx.
 */
function defaultWorkerUrl(): URL {
  const fromSource = import.meta.url.endsWith(".ts");
  return new URL(fromSource ? "./read-worker-thread.ts" : "./read-worker-thread.js", import.meta.url);
}

/**
 * Runs the console's slow reads off the thread that forwards calls.
 *
 * One worker with its own read-only connection; tasks queue there rather
 * than on the proxy. Without a database file to open (an in-memory database
 * in tests) or when switched off, tasks run in-process as they always did.
 * A worker that dies is replaced on the next task, and the task it was
 * running fails with a plain error rather than hanging.
 */
export class ReadPool {
  readonly #db: Db;
  readonly #path: string | undefined;
  readonly #workerUrl: URL;
  #worker: Worker | undefined;
  #nextId = 0;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /**
   * @param path the database file, or undefined to run every task in-process
   * @param workerUrl the compiled worker script; tests point it at dist
   */
  constructor(db: Db, path: string | undefined, workerUrl = defaultWorkerUrl()) {
    this.#db = db;
    this.#path = path === undefined || path === ":memory:" ? undefined : path;
    this.#workerUrl = workerUrl;
  }

  get threaded(): boolean {
    return this.#path !== undefined;
  }

  run<N extends ReadTaskName>(name: N, ...args: ReadTaskArgs<N>): Promise<ReadTaskResult<N>> {
    if (this.#path === undefined) {
      const task = READ_TASKS[name] as (db: Db, ...rest: unknown[]) => ReadTaskResult<N>;
      try {
        return Promise.resolve(task(this.#db, ...args));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    return new Promise<ReadTaskResult<N>>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, name, args });
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    // Run from source, the worker has to register tsx itself: a loader the
    // parent registered does not carry over into a worker thread.
    const fromSource = this.#workerUrl.pathname.endsWith(".ts");
    const worker = fromSource
      ? new Worker(
          `import("tsx/esm/api").then((tsx) => { tsx.register(); return import(${JSON.stringify(this.#workerUrl.href)}); });`,
          { eval: true, workerData: { path: this.#path } },
        )
      : new Worker(this.#workerUrl, { workerData: { path: this.#path } });
    // A worker idle between reports must not keep the process alive at exit.
    worker.unref();
    worker.on("message", (message: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const waiting = this.#pending.get(message.id);
      if (waiting === undefined) return;
      this.#pending.delete(message.id);
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(message.error));
    });
    const lost = (reason: string): void => {
      if (this.#worker === worker) this.#worker = undefined;
      for (const [id, waiting] of this.#pending) {
        this.#pending.delete(id);
        waiting.reject(new Error(`the report could not be read: ${reason}`));
      }
    };
    worker.on("error", (error) => lost(error.message));
    worker.on("exit", (code) => lost(`the reader stopped (exit ${code})`));
    this.#worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker !== undefined) await worker.terminate();
  }
}
