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
  extractTools: true,
  allowAnonymous: false,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  logLevel: "silent",
};

const USAGE = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

describe("did it work", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;
  let app: FastifyInstance;
  let apiKey: string;

  const call = (run: string) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "worker", "x-costgrid-run": run },
      payload: { model: "claude-haiku-4-5", max_tokens: 100 },
    });

  const report = (payload: unknown, key = apiKey) =>
    app.inject({
      method: "POST",
      url: "/v1/costgrid/outcome",
      headers: { "x-costgrid-key": key, "content-type": "application/json" },
      payload: payload as never,
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
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ model: "claude-haiku-4-5", stop_reason: "end_turn", usage: USAGE }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it("records what the caller reports", async () => {
    await call("run-1");
    const response = await report({ run_id: "run-1", success: true });

    expect(response.statusCode).toBe(202);
    const summary = analytics.outcomes("t1", window());
    expect(summary.reportedRuns).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.costPerSuccess).toBeGreaterThan(0n);
  });

  it("attributes the run's whole cost to its outcome", async () => {
    await call("run-1");
    await call("run-1");
    await call("run-2");
    await report({ run_id: "run-1", success: true });
    await report({ run_id: "run-2", success: false });

    const summary = analytics.outcomes("t1", window());
    // Two calls succeeded, one failed, so success cost twice as much.
    expect(summary.costOfSuccess).toBe(summary.costOfFailure * 2n);
    expect(summary.costPerSuccess).toBe(summary.costOfSuccess);
  });

  it("lets a run change its mind", async () => {
    await call("run-1");
    await report({ run_id: "run-1", success: true });
    await report({ run_id: "run-1", success: false });

    const summary = analytics.outcomes("t1", window());
    // Not two outcomes. One run, latest answer.
    expect(summary.reportedRuns).toBe(1);
    expect(summary.succeeded).toBe(0);
  });

  /*
   * The denominator is the point. A 100% success rate over one of a thousand
   * runs is not a success rate, and the summary has to carry enough for a
   * reader to see that.
   */
  it("always reports how many runs the rate covers", async () => {
    for (let i = 0; i < 10; i += 1) await call(`run-${i}`);
    await report({ run_id: "run-0", success: true });

    const summary = analytics.outcomes("t1", window());
    expect(summary.succeeded).toBe(1);
    expect(summary.reportedRuns).toBe(1);
    expect(summary.totalRuns).toBe(10);
  });

  it("gives no answer rather than zero when nothing is reported", async () => {
    await call("run-1");
    const summary = analytics.outcomes("t1", window());
    expect(summary.reportedRuns).toBe(0);
    expect(summary.costPerSuccess).toBeUndefined();
  });

  it("ignores runs CostGrid invented", async () => {
    // No run header, so this is a run of one that the caller never named.
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "worker" },
      payload: { model: "claude-haiku-4-5", max_tokens: 100 },
    });
    expect(analytics.outcomes("t1", window()).totalRuns).toBe(0);
  });

  // --------------------------------------------------------------- guards

  it("rejects a report with no run id", async () => {
    expect((await report({ success: true })).statusCode).toBe(400);
  });

  it("rejects a success that is not true or false", async () => {
    expect((await report({ run_id: "r", success: "yes" })).statusCode).toBe(400);
  });

  it("rejects an unauthenticated report", async () => {
    expect((await report({ run_id: "r", success: true }, "not-a-key")).statusCode).toBe(401);
  });

  /*
   * A label groups outcomes. It is not a field for describing what happened,
   * because that would be content, which this product promises never to keep.
   */
  it("caps the label so it cannot become a description", async () => {
    await call("run-1");
    await report({ run_id: "run-1", success: true, label: "x".repeat(500) });

    const stored = db
      .prepare("SELECT label FROM outcomes WHERE run_id = 'run-1'")
      .get() as { label: string };
    expect(stored.label).toHaveLength(64);
  });

  it("keeps one tenant's outcomes out of another's", async () => {
    repository.createTenant("Other", "t2");
    const otherKey = repository.createApiKey("t2", "svc").plaintext;

    await call("run-1");
    await report({ run_id: "run-1", success: true }, otherKey);

    // Reported under t2, so t1 has nothing.
    expect(analytics.outcomes("t1", window()).reportedRuns).toBe(0);
  });
});
