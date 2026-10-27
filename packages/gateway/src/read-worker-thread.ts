import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "@costgrid/db";
import { READ_TASKS, type ReadTaskName } from "./read-tasks.js";

/**
 * The thread `ReadPool` starts. It opens the database read-only, so nothing it
 * does can change a figure, and answers one task at a time.
 */

const db = openDatabase({ path: (workerData as { path: string }).path, readonly: true });

parentPort!.on("message", (message: { id: number; name: ReadTaskName; args: unknown[] }) => {
  try {
    const task = READ_TASKS[message.name] as (...args: unknown[]) => unknown;
    const result = task(db, ...message.args);
    parentPort!.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    parentPort!.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
