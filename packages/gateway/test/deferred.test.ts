import { Analytics, CostGridRepository, DeferredBatches, ImportsRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer, deferredOf } from "../src/server.js";

const CONFIG: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: { anthropic: "sk-ant-test", openai: "sk-openai-test" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  allowAnonymous: false,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  logLevel: "silent",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for both providers' batch APIs, following their published shapes. */
class StubProviders {
  calls: { method: string; path: string; body?: unknown; headers: Record<string, string> }[] = [];
  ended = false;
  submitted: unknown[] = [];
  /** Reading results fails this many more times. */
  resultsFailures = 0;
  /** Reading results waits on this, to look at the batch mid-read. */
  resultsGate: Promise<void> | undefined;

  fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const method = init?.method ?? "GET";
    let body: unknown;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    this.calls.push({ method, path: url.pathname, body, headers });

    // ---- Anthropic
    if (url.pathname === "/v1/messages/batches" && method === "POST") {
      this.submitted = (body as { requests: unknown[] }).requests;
      return json({ id: "msgbatch_1", processing_status: "in_progress", request_counts: { processing: 2 } });
    }
    if (url.pathname === "/v1/messages/batches/msgbatch_1") {
      return json(
        this.ended
          ? {
              id: "msgbatch_1",
              processing_status: "ended",
              request_counts: { succeeded: 1, errored: 1 },
              ended_at: "2026-11-04T10:00:00Z",
              results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results",
            }
          : { id: "msgbatch_1", processing_status: "in_progress", request_counts: { processing: 2 } },
      );
    }
    if (url.pathname === "/v1/messages/batches/msgbatch_1/results") {
      await this.resultsGate;
      if (this.resultsFailures > 0) {
        this.resultsFailures -= 1;
        return json({ error: "unavailable" }, 503);
      }
      return new Response(
        [
          JSON.stringify({
            custom_id: "a",
            result: {
              type: "succeeded",
              message: { model: "claude-sonnet-4-6", stop_reason: "end_turn", usage: { input_tokens: 1_000_000, output_tokens: 0 }, content: [{ type: "text", text: "secret answer" }] },
            },
          }),
          JSON.stringify({ custom_id: "b", result: { type: "errored", error: { type: "invalid_request_error" } } }),
        ].join("\n") + "\n",
      );
    }

    // ---- OpenAI
    if (url.pathname === "/v1/files" && method === "POST") return json({ id: "file-in" });
    if (url.pathname === "/v1/batches" && method === "POST") {
      return json({ id: "batch_1", status: "validating", request_counts: { total: 1 } });
    }
    if (url.pathname === "/v1/batches/batch_1") {
      return json(
        this.ended
          ? { id: "batch_1", status: "completed", request_counts: { completed: 1, failed: 0 }, output_file_id: "file-out", completed_at: 1_762_250_000 }
          : { id: "batch_1", status: "in_progress", request_counts: { completed: 0 } },
      );
    }
    if (url.pathname === "/v1/files/file-out/content") {
      return new Response(
        JSON.stringify({
          custom_id: "q1",
          response: { status_code: 200, body: { model: "gpt-4o", choices: [], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } } },
        }) + "\n",
      );
    }
    return json({ error: "not stubbed" }, 404);
  }) as unknown as typeof fetch;
}

describe("deferred jobs at the batch rate", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let app: FastifyInstance;
  let apiKey: string;
  let stub: StubProviders;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    stub = new StubProviders();
    app = createServer({
      config: CONFIG,
      db,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      fetchImpl: stub.fetch,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const headers = () => ({ "x-costgrid-key": apiKey, "x-costgrid-agent": "nightly" });
  const submit = (payload: unknown) =>
    app.inject({ method: "POST", url: "/v1/costgrid/deferred", headers: headers(), payload });

  const anthropicBatch = {
    provider: "anthropic",
    requests: [
      { custom_id: "a", params: { model: "claude-sonnet-4-6", max_tokens: 100, messages: [] } },
      { custom_id: "b", params: { model: "claude-sonnet-4-6", max_tokens: 100, messages: [] } },
    ],
  };

  it("sends Claude work to the batch API, checks it, prices it at half and passes results back", async () => {
    const res = await submit(anthropicBatch);
    expect(res.statusCode).toBe(202);
    const created = res.json() as { id: string; status: string; request_count: number; rejected: unknown[] };
    expect(created).toMatchObject({ status: "in_progress", request_count: 2, rejected: [] });
    expect(stub.submitted).toHaveLength(2);
    expect(stub.calls[0]!.headers["x-api-key"]).toBe("sk-ant-test");

    stub.ended = true;
    await deferredOf(app)!.sweep(Date.now() + 120_000);

    const status = (await app.inject({ method: "GET", url: `/v1/costgrid/deferred/${created.id}`, headers: headers() })).json();
    // $3 per million input tokens on Sonnet, halved.
    expect(status).toMatchObject({ status: "ended", succeeded: 1, errored: 1, cost_usd: "1.500000", results_ready: true });

    const calls = db
      .prepare("SELECT agent_id AS agent, outcome, batch, cost_total AS cost FROM calls ORDER BY outcome DESC")
      .all();
    expect(calls).toEqual([
      { agent: "nightly", outcome: "ok", batch: 1, cost: 1_500_000_000 },
      { agent: "nightly", outcome: "error", batch: 0, cost: 0 },
    ]);
    // A second sweep prices nothing twice.
    await deferredOf(app)!.sweep(Date.now() + 240_000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 2 });

    const results = await app.inject({ method: "GET", url: `/v1/costgrid/deferred/${created.id}/results`, headers: headers() });
    expect(results.statusCode).toBe(200);
    expect(results.body).toContain("secret answer");
  });

  it("prices a batch whose pricing stopped part-way exactly once, later", async () => {
    const { id } = (await submit(anthropicBatch)).json() as { id: string };
    stub.ended = true;
    stub.resultsFailures = 1;
    await deferredOf(app)!.sweep(Date.now() + 120_000);
    // Nothing recorded, and nothing left claimed: the batch is still waiting to be priced.
    expect(db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT metered_at AS m FROM deferred_batches WHERE id = ?").get(id)).toEqual({ m: null });

    // While results are being read, nothing is marked, so an app that quits
    // now leaves the batch to be priced next time. Two checks at once still
    // record each call once.
    let open!: () => void;
    stub.resultsGate = new Promise((resolve) => (open = resolve));
    const sweeps = Promise.all([deferredOf(app)!.sweep(Date.now() + 240_000), deferredOf(app)!.sweep(Date.now() + 240_000)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(db.prepare("SELECT metered_at AS m FROM deferred_batches WHERE id = ?").get(id)).toEqual({ m: null });
    open();
    await sweeps;
    expect(db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toEqual({ n: 2 });
  });

  it("stores no prompt and no answer", async () => {
    const { id } = (await submit(anthropicBatch)).json() as { id: string };
    stub.ended = true;
    await deferredOf(app)!.sweep(Date.now() + 120_000);
    await app.inject({ method: "GET", url: `/v1/costgrid/deferred/${id}/results`, headers: headers() });
    const everything = JSON.stringify(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap((t) =>
        db.prepare(`SELECT * FROM "${(t as { name: string }).name}"`).all(),
      ),
      (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(everything).not.toContain("secret answer");
  });

  it("uploads OpenAI work as a file and prices its results", async () => {
    const res = await submit({
      provider: "openai",
      requests: [{ custom_id: "q1", params: { model: "gpt-4o", messages: [{ role: "user", content: "x" }] } }],
    });
    expect(res.statusCode).toBe(202);
    const created = res.json() as { id: string };
    expect(stub.calls.map((c) => c.path)).toEqual(["/v1/files", "/v1/batches"]);
    expect(stub.calls[1]!.body).toEqual({ input_file_id: "file-in", endpoint: "/v1/chat/completions", completion_window: "24h" });

    stub.ended = true;
    await deferredOf(app)!.sweep(Date.now() + 120_000);
    const batch = new DeferredBatches(db).get("t1", created.id)!;
    expect(batch.status).toBe("ended");
    // gpt-4o input at $2.50 per million, halved.
    expect(batch.cost).toBe(1_250_000_000n);
  });

  it("applies policies to each request: refused ones come back and are not sent", async () => {
    repository.createPolicy("t1", {
      name: "no sonnet",
      scope: { kind: "tenant" },
      rule: { kind: "model-denylist", models: ["claude-sonnet-4-6"] },
      action: "block",
      enabled: true,
    });
    const res = await submit({
      provider: "anthropic",
      requests: [
        ...anthropicBatch.requests,
        { custom_id: "c", params: { model: "claude-haiku-4-5", max_tokens: 10, messages: [] } },
      ],
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { request_count: number; rejected: { custom_id: string }[] };
    expect(body.request_count).toBe(1);
    expect(body.rejected.map((r) => r.custom_id)).toEqual(["a", "b"]);
    expect(stub.submitted).toHaveLength(1);
  });

  it("refuses an all-refused batch, bad ids, streaming and the cloud channels", async () => {
    expect((await submit({ provider: "bedrock", requests: [] })).statusCode).toBe(400);
    expect((await submit({ provider: "anthropic", requests: [] })).statusCode).toBe(400);
    expect(
      (await submit({ provider: "anthropic", requests: [{ custom_id: "has space", params: {} }] })).statusCode,
    ).toBe(400);
    const streaming = await submit({
      provider: "anthropic",
      requests: [{ custom_id: "s", params: { model: "claude-sonnet-4-6", stream: true, max_tokens: 1, messages: [] } }],
    });
    expect(streaming.statusCode).toBe(422);
    expect(stub.calls).toEqual([]);
  });

  it("accepts a multi-megabyte batch, while other /v1/costgrid/ routes keep their 1 MiB limit", async () => {
    // 500 ordinary prompts of 8 KB each: about 4 MB, well over 1 MiB.
    const prompt = "x".repeat(8_000);
    const requests = Array.from({ length: 500 }, (_, i) => ({
      custom_id: `r${i}`,
      params: { model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: prompt }] },
    }));
    const big = await submit({ provider: "anthropic", requests });
    expect(big.statusCode).toBe(202);
    expect((big.json() as { request_count: number }).request_count).toBe(500);

    const outcome = await app.inject({
      method: "POST",
      url: "/v1/costgrid/outcome",
      headers: { ...headers(), "content-type": "application/json" },
      payload: JSON.stringify({ run_id: "r", success: true, pad: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(outcome.statusCode).toBe(413);
  });

  it("needs an API key, and never shows one organisation's batch to another", async () => {
    const { id } = (await submit(anthropicBatch)).json() as { id: string };
    expect((await app.inject({ method: "GET", url: `/v1/costgrid/deferred/${id}` })).statusCode).toBe(401);
    repository.createTenant("Other", "t2");
    const other = repository.createApiKey("t2", "svc").plaintext;
    const res = await app.inject({ method: "GET", url: `/v1/costgrid/deferred/${id}`, headers: { "x-costgrid-key": other } });
    expect(res.statusCode).toBe(404);
  });
});
