import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { priceUsage, ZERO_USAGE } from "@costgrid/core";
import { Analytics, CostGridRepository, openDatabase, RunOutcomes } from "@costgrid/db";
import { afterEach, describe, expect, it } from "vitest";
import { ReadPool } from "../src/read-pool.js";

// Workers run compiled JavaScript, so the test uses the build (CI builds first).
const WORKER = new URL("../dist/read-worker-thread.js", import.meta.url);
const NOW = Date.UTC(2026, 9, 27, 12);
const RANGE = { from: NOW - 30 * 86_400_000, to: NOW + 1 };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function populated() {
  const dir = mkdtempSync(join(tmpdir(), "costgrid-reads-"));
  const path = join(dir, "costgrid.db");
  const db = openDatabase({ path });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close());
  const repo = new CostGridRepository(db);
  repo.createTenant("Acme", "t1");
  for (let i = 0; i < 60; i++) {
    const usage = { ...ZERO_USAGE, inputTokens: 1000 + i, outputTokens: 100 + i };
    const priced = priceUsage("claude-sonnet-4-5", usage);
    repo.recordCall({
      id: `c${i}`, tenantId: "t1", agentId: `agent-${i % 3}`, department: "Eng", provider: "anthropic",
      model: "claude-sonnet-4-5", startedAt: NOW - i * 3_600_000, durationMs: 10, streamed: false, usage,
      cost: priced.cost, priced: priced.priced, outcome: i % 7 === 0 ? "error" : "ok", runId: `r${Math.floor(i / 2)}`, runDeclared: true,
    });
  }
  return { db, path };
}

describe("the read pool", () => {
  it("gives the same answers on its thread as in-process", async () => {
    const { db, path } = populated();
    const pool = new ReadPool(db, path, WORKER);
    cleanups.push(() => pool.close());
    expect(pool.threaded).toBe(true);

    expect(await pool.run("agentDetail", "t1", RANGE)).toEqual(new Analytics(db).agentDetail("t1", RANGE));
    expect(await pool.run("topology", "t1", RANGE)).toEqual(new Analytics(db).topology("t1", RANGE));
    expect(await pool.run("outcomes", "t1", RANGE, NOW)).toEqual(new RunOutcomes(db).forTenant("t1", RANGE, NOW));
  });

  it("sees calls recorded after it started", async () => {
    const { db, path } = populated();
    const pool = new ReadPool(db, path, WORKER);
    cleanups.push(() => pool.close());
    const before = await pool.run("agentDetail", "t1", RANGE);
    const usage = { ...ZERO_USAGE, inputTokens: 5, outputTokens: 5 };
    const priced = priceUsage("claude-sonnet-4-5", usage);
    new CostGridRepository(db).recordCall({
      id: "late", tenantId: "t1", agentId: "agent-new", department: "Eng", provider: "anthropic", model: "claude-sonnet-4-5",
      startedAt: NOW, durationMs: 1, streamed: false, usage, cost: priced.cost, priced: priced.priced, outcome: "ok",
    });
    const after = await pool.run("agentDetail", "t1", RANGE);
    expect(after.length).toBe(before.length + 1);
  });

  it("runs in-process for an in-memory database", async () => {
    const db = openDatabase({ path: ":memory:" });
    cleanups.push(() => db.close());
    const pool = new ReadPool(db, ":memory:", WORKER);
    expect(pool.threaded).toBe(false);
    expect(await pool.run("agentDetail", "t1", RANGE)).toEqual([]);
  });

  it("reports a failed task as an error instead of hanging", async () => {
    const { db, path } = populated();
    const pool = new ReadPool(db, path, WORKER);
    cleanups.push(() => pool.close());
    await expect(pool.run("no-such-report" as never)).rejects.toThrow();
    await pool.close();
    // Closed, the next task starts a fresh reader rather than failing for good.
    expect(await pool.run("agentDetail", "t1", RANGE)).toEqual(new Analytics(db).agentDetail("t1", RANGE));
  });
});
