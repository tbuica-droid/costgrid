import { Analytics, CostGridRepository, ImportsRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * What happens when CostGrid cannot write down what it just watched.
 *
 * The failure this guards against is specific and was real: a full disk or a
 * locked database threw out of the request handler *after* the provider had
 * already produced tokens, so the caller got a 500 on a call that had
 * succeeded upstream. They were billed for an answer they never received, and
 * the obvious response, retrying, billed them again.
 *
 * The rule these tests encode is an asymmetry:
 *
 * - Deciding whether a call may proceed is **fail-closed**. If that breaks,
 *   nothing reaches the provider.
 * - Recording what a call did is **fail-open**. By then the money is spent, so
 *   the customer gets their answer and the lost row is counted and shouted
 *   about.
 *
 * Getting this backwards is not a rough edge, it is charging somebody for
 * nothing.
 */

const CONFIG: GatewayConfig = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  providerKeys: { anthropic: "sk-ant-test-not-a-real-key" },
  providerBaseUrls: {},
  upstreamTimeoutMs: 5_000,
  injectUsageRequest: true,
  extractTools: true,
  allowAnonymous: false,
  hosted: false,
  masterKeySecret: undefined,
  secureCookies: false,
  publicUrl: undefined,
  logLevel: "silent",
};

const MESSAGE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text: "the answer they paid for" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

const STREAM_CHUNKS = [
  `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { id: "msg_s", model: "claude-opus-5", usage: { input_tokens: 900, output_tokens: 1 } },
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    delta: { type: "text_delta", text: "streamed answer" },
  })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 400 },
  })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
];

describe("when the metering write fails", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: FastifyInstance;
  let apiKey: string;
  let attempts: number;

  /**
   * A repository whose writes fail the way a full disk fails.
   *
   * Wrapping the real one rather than faking it wholesale: everything the
   * gateway reads still behaves normally, so the test isolates the write.
   */
  function failingRepository(which: "calls" | "violations" | "everything"): CostGridRepository {
    const real = new CostGridRepository(db);
    const boom = (): never => {
      attempts++;
      throw new Error("SQLITE_FULL: database or disk is full");
    };
    return new Proxy(real, {
      get(target, property, receiver) {
        if (
          (which !== "violations" && property === "recordCall") ||
          (which !== "calls" && property === "recordViolations") ||
          (which === "everything" && property === "recordTools")
        ) {
          return boom;
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as CostGridRepository;
  }

  function boot(repository: CostGridRepository, upstream: () => Response): void {
    app = createServer({
      config: CONFIG,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      fetchImpl: (async () => upstream()) as unknown as typeof fetch,
    });
  }

  const send = (body: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "bot" },
      payload: { model: "claude-opus-5", max_tokens: 100, ...body },
    });

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    const setup = new CostGridRepository(db);
    setup.createTenant("Acme", "t1");
    apiKey = setup.createApiKey("t1", "svc").plaintext;
    attempts = 0;
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  it("still returns the answer the provider was paid for", async () => {
    boot(failingRepository("everything"), () =>
      new Response(JSON.stringify(MESSAGE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await send();

    expect(attempts).toBeGreaterThan(0);
    expect(response.statusCode).toBe(200);
    // Not a truncated or substituted body: the caller gets exactly what the
    // provider produced, which is what they were charged for.
    expect(response.json()).toEqual(MESSAGE);
  });

  it("still streams the answer through", async () => {
    boot(failingRepository("everything"), () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of STREAM_CHUNKS) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const response = await send({ stream: true });

    expect(attempts).toBeGreaterThan(0);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("streamed answer");
  });

  it("counts the loss and says so on /health", async () => {
    boot(failingRepository("calls"), () =>
      new Response(JSON.stringify(MESSAGE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await send();
    await send();

    const health = await app.inject({ method: "GET", url: "/health" });
    const body = health.json() as {
      status: string;
      meteringFailures: number;
      lastMeteringFailure?: { reason: string };
    };

    expect(body.meteringFailures).toBe(2);
    expect(body.lastMeteringFailure?.reason).toContain("disk is full");
    // Deliberately still 200 and still "ok". A metering failure must not take
    // the gateway out of a load balancer: that would convert losing a row into
    // refusing every call, which is the trade the guard exists to avoid.
    expect(health.statusCode).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("reports nothing when nothing has failed", async () => {
    boot(new CostGridRepository(db), () =>
      new Response(JSON.stringify(MESSAGE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await send();

    const body = (await app.inject({ method: "GET", url: "/health" })).json() as {
      meteringFailures: number;
      lastMeteringFailure?: unknown;
    };
    expect(body.meteringFailures).toBe(0);
    expect(body.lastMeteringFailure).toBeUndefined();
  });

  it("still refuses a blocked call when the refusal cannot be recorded", async () => {
    const repository = failingRepository("everything");
    new CostGridRepository(db).createPolicy("t1", {
      name: "no opus",
      scope: { kind: "tenant" },
      rule: { kind: "model-denylist", models: ["claude-opus-5"] },
      action: "block",
      enabled: true,
    });

    boot(repository, () => {
      throw new Error("the provider must never be reached for a blocked call");
    });

    const response = await send();

    // The enforcement lives in the refusal, not in the write. A failing disk
    // must not become a way to get past a policy.
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { type: string } }).error.type).toBe(
      "costgrid_policy_blocked",
    );
    expect(attempts).toBeGreaterThan(0);
  });

  it("still reports an upstream failure as an upstream failure", async () => {
    boot(failingRepository("everything"), () => {
      throw new Error("connect ECONNREFUSED");
    });

    const response = await send();

    // Two failures at once, and the caller must be told about the one that
    // affects them: 502 upstream, not 500 from our own bookkeeping.
    expect(response.statusCode).toBe(502);
    expect((response.json() as { error: { type: string } }).error.type).toBe(
      "upstream_unreachable",
    );
  });
});
