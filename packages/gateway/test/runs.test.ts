import { usd } from "@costgrid/core";
import { Analytics, CostGridRepository, ImportsRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const CONFIG: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: { anthropic: "sk-ant-test" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  logLevel: "silent",
};

/** 1M in, 1M out — a rate reads straight off as dollars. */
const USAGE = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe("runs", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;
  let app: FastifyInstance;
  let apiKey: string;

  const send = (
    over: { model?: string; run?: string; parent?: string; agent?: string } = {},
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-costgrid-key": apiKey,
        "x-costgrid-agent": over.agent ?? "worker",
        ...(over.run ? { "x-costgrid-run": over.run } : {}),
        ...(over.parent ? { "x-costgrid-parent-run": over.parent } : {}),
      },
      payload: { model: over.model ?? "claude-haiku-4-5", max_tokens: 100 },
    });

  const window = () => ({ from: 0, to: Date.now() + 1000 });

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    analytics = new Analytics(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    app = createServer({
      config: CONFIG,
      repository,
      analytics,
      imports: new ImportsRepository(db),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        return new Response(
          JSON.stringify({ model: body.model, stop_reason: "end_turn", usage: USAGE }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  const policy = (
    rule: Parameters<CostGridRepository["createPolicy"]>[1]["rule"],
    action: "monitor" | "warn" | "block" = "block",
  ) =>
    repository.createPolicy("t1", {
      name: "run rule",
      scope: { kind: "tenant" },
      rule,
      action,
      enabled: true,
    });

  // ------------------------------------------------------------- grouping

  it("groups calls that share a run header", async () => {
    await send({ run: "run-a" });
    await send({ run: "run-a" });
    await send({ run: "run-b" });

    const runs = analytics.runsSummary("t1", window());
    expect(runs.map((r) => r.runId).sort()).toEqual(["run-a", "run-b"]);
    expect(runs.find((r) => r.runId === "run-a")?.calls).toBe(2);
  });

  it("meters a call with no run header as a run of one", async () => {
    await send();
    await send();

    // Undeclared runs are excluded from the runs view — thousands of runs of
    // one would bury the handful of real ones.
    expect(analytics.runsSummary("t1", window())).toHaveLength(0);
    const coverage = analytics.runCoverage("t1", window());
    expect(coverage).toEqual({ declared: 0, total: 2 });

    // They are still grouped, so nothing in the schema has a null branch.
    const rows = db.prepare("SELECT id, run_id AS runId FROM calls").all() as {
      id: string;
      runId: string;
    }[];
    for (const row of rows) expect(row.runId).toBe(row.id);
  });

  it("rejects a run id that is not safe to carry around", async () => {
    // It lands in an index, a URL and a terminal; a 4KB header or an escape
    // sequence should be ignored rather than stored.
    await send({ run: "a b\nc" });
    await send({ run: "x".repeat(200) });

    expect(analytics.runCoverage("t1", window()).declared).toBe(0);
  });

  // ---------------------------------------------------------- enforcement

  it("stops a runaway loop at its step cap", async () => {
    policy({ kind: "run-steps", limit: 3 });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await send({ run: "loop" })).statusCode);

    // Three get through, the rest are refused — and refusal costs nothing.
    expect(statuses).toEqual([200, 200, 200, 403, 403, 403]);
    const runs = analytics.runsSummary("t1", window());
    expect(runs[0]?.blockedCalls).toBe(3);
    expect(analytics.summary("t1", window()).totalCost).toBe(usd("18.00")); // 3 x $6 Haiku
  });

  it("stops a run that spends its ceiling", async () => {
    policy({ kind: "run-budget", limit: usd("10.00") });

    expect((await send({ run: "r" })).statusCode).toBe(200); // $6 spent
    expect((await send({ run: "r" })).statusCode).toBe(200); // $12 — over, but only after
    expect((await send({ run: "r" })).statusCode).toBe(403);
  });

  it("downgrades an over-budget run instead of refusing it", async () => {
    policy({ kind: "run-budget", limit: usd("10.00"), fallbackModel: "claude-haiku-4-5" });

    await send({ run: "r", model: "claude-opus-5" }); // $30, blows the ceiling
    const res = await send({ run: "r", model: "claude-opus-5" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-costgrid-fallback"]).toBe("claude-opus-5->claude-haiku-4-5");
    expect(res.json().model).toBe("claude-haiku-4-5");
  });

  it("leaves a run alone while it is within its limits", async () => {
    policy({ kind: "run-budget", limit: usd("1000.00") });
    policy({ kind: "run-steps", limit: 50 });

    expect((await send({ run: "fine" })).statusCode).toBe(200);
    expect(analytics.runsSummary("t1", window())[0]?.blockedCalls).toBe(0);
  });

  it("does not let one run's spend bleed into another", async () => {
    policy({ kind: "run-budget", limit: usd("10.00") });

    await send({ run: "first" });
    await send({ run: "first" }); // first is now over
    expect((await send({ run: "first" })).statusCode).toBe(403);
    // A different run starts from zero.
    expect((await send({ run: "second" })).statusCode).toBe(200);
  });

  it("cannot fire on traffic that carries no run id", async () => {
    policy({ kind: "run-steps", limit: 1 });

    for (let i = 0; i < 5; i += 1) expect((await send()).statusCode).toBe(200);
  });

  // ------------------------------------------------------------ delegation

  it("tracks delegation depth from the parent run", async () => {
    await send({ run: "root" });
    await send({ run: "child", parent: "root" });
    await send({ run: "grandchild", parent: "child" });

    const byId = new Map(analytics.runsSummary("t1", window()).map((r) => [r.runId, r.depth]));
    expect(byId.get("root")).toBe(0);
    expect(byId.get("child")).toBe(1);
    expect(byId.get("grandchild")).toBe(2);
  });

  it("refuses a delegation deeper than the limit", async () => {
    policy({ kind: "run-depth", limit: 1 });

    expect((await send({ run: "root" })).statusCode).toBe(200);
    expect((await send({ run: "child", parent: "root" })).statusCode).toBe(200);
    expect((await send({ run: "grandchild", parent: "child" })).statusCode).toBe(403);
  });

  it("treats an unmetered parent as depth zero rather than inventing one", async () => {
    // Understating is recoverable; a fabricated depth would silently refuse
    // traffic that never breached anything.
    await send({ run: "orphan", parent: "never-seen" });
    expect(analytics.runsSummary("t1", window())[0]?.depth).toBe(1);
  });

  // ---------------------------------------------------------------- detail

  it("numbers the steps of a run in the order they happened", async () => {
    await send({ run: "r", model: "claude-haiku-4-5" });
    await send({ run: "r", model: "claude-opus-5" });

    const steps = analytics.runDetail("t1", "r");
    expect(steps.map((s) => s.step)).toEqual([1, 2]);
    expect(steps.map((s) => s.model)).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    expect(steps[1]?.cost).toBe(usd("30.00"));
  });

  it("shows a blocked step in the run it was refused from", async () => {
    policy({ kind: "run-steps", limit: 1 });
    await send({ run: "r" });
    await send({ run: "r" });

    const steps = analytics.runDetail("t1", "r");
    expect(steps).toHaveLength(2);
    expect(steps[1]?.outcome).toBe("blocked");
    expect(steps[1]?.cost).toBe(0n);
  });
});
