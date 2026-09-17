import { Analytics, CostGridRepository, ImportsRepository, openDatabase } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { assertToolPoliciesEnforceable, createServer } from "../src/server.js";

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

const USAGE = { input_tokens: 1_000, output_tokens: 500 };

/**
 * End-to-end cover for tool boundaries.
 *
 * The unit tests in core pin the rule; these pin the thing that makes the rule
 * a product — that the delegation chain is read out of real metered traffic
 * rather than passed in by the test.
 */
describe("tool boundaries end to end", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;
  let app: FastifyInstance;
  let apiKey: string;
  let upstreamCalls = 0;

  const send = (over: { agent?: string; run?: string; parent?: string; tools?: string[] }) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-costgrid-key": apiKey,
        "x-costgrid-agent": over.agent ?? "worker",
        ...(over.run ? { "x-costgrid-run": over.run } : {}),
        ...(over.parent ? { "x-costgrid-parent-run": over.parent } : {}),
      },
      payload: {
        model: "claude-haiku-4-5",
        max_tokens: 100,
        ...(over.tools ? { tools: over.tools.map((name) => ({ name })) } : {}),
      },
    });

  beforeEach(() => {
    upstreamCalls = 0;
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
      fetchImpl: (async () => {
        upstreamCalls += 1;
        return new Response(
          JSON.stringify({ model: "claude-haiku-4-5", stop_reason: "end_turn", usage: USAGE }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  const denyRefunds = (transitive = true) =>
    repository.createPolicy("t1", {
      name: "no refunds",
      scope: { kind: "agent", agentId: "support" },
      rule: {
        kind: "tool-denylist",
        tools: ["refund_customer"],
        ...(transitive ? {} : { transitive: false }),
      },
      action: "block",
      enabled: true,
    });

  it("refuses the call before it reaches the provider", async () => {
    denyRefunds();
    const response = await send({ agent: "support", tools: ["refund_customer"] });

    expect(response.statusCode).toBe(403);
    // The point of being inline: nothing was forwarded, so nothing was spent
    // and there is no tool_use for the customer's harness to execute.
    expect(upstreamCalls).toBe(0);
  });

  it("lets the same agent through when it offers other tools", async () => {
    denyRefunds();
    const response = await send({ agent: "support", tools: ["search_docs"] });
    expect(response.statusCode).toBe(200);
    expect(upstreamCalls).toBe(1);
  });

  /*
   * The headline claim on the site: "may not reach refund_customer, directly
   * or through anything it delegates to." The chain here is discovered from
   * the metered parent call, not supplied by the test.
   */
  it("stops a delegate reaching the tool on the blocked agent's behalf", async () => {
    denyRefunds();

    // support runs, and hands work to billing.
    await send({ agent: "support", run: "run-1", tools: ["search_docs"] });
    const delegated = await send({
      agent: "billing",
      run: "run-2",
      parent: "run-1",
      tools: ["refund_customer"],
    });

    expect(delegated.statusCode).toBe(403);
    expect(JSON.parse(delegated.body).error.message).toContain("support");
  });

  it("follows the chain more than one hop", async () => {
    denyRefunds();
    await send({ agent: "support", run: "run-1", tools: ["search_docs"] });
    await send({ agent: "billing", run: "run-2", parent: "run-1", tools: ["search_docs"] });

    const grandchild = await send({
      agent: "ledger",
      run: "run-3",
      parent: "run-2",
      tools: ["refund_customer"],
    });
    expect(grandchild.statusCode).toBe(403);
  });

  it("leaves a delegate of an unrelated agent alone", async () => {
    denyRefunds();
    await send({ agent: "reporting", run: "run-1", tools: ["search_docs"] });
    const delegated = await send({
      agent: "billing",
      run: "run-2",
      parent: "run-1",
      tools: ["refund_customer"],
    });
    expect(delegated.statusCode).toBe(200);
  });

  it("does not reach past the first hop when the rule is direct-only", async () => {
    denyRefunds(false);
    await send({ agent: "support", run: "run-1", tools: ["search_docs"] });
    const delegated = await send({
      agent: "billing",
      run: "run-2",
      parent: "run-1",
      tools: ["refund_customer"],
    });
    expect(delegated.statusCode).toBe(200);
  });

  /*
   * A delegation cycle is a malformed fleet, not an attack, but it reaches the
   * request path — so the walk has to terminate rather than hang the call.
   */
  it("terminates on a delegation cycle", async () => {
    denyRefunds();
    await send({ agent: "a", run: "run-1", parent: "run-2", tools: ["search_docs"] });
    await send({ agent: "b", run: "run-2", parent: "run-1", tools: ["search_docs"] });

    const response = await send({ agent: "c", run: "run-3", parent: "run-1", tools: ["search_docs"] });
    expect(response.statusCode).toBe(200);
  });

  it("reads a chain of unmetered parents as no chain, not as an error", async () => {
    denyRefunds();
    // Nobody ever metered run-0, so the boundary cannot see who delegated.
    const response = await send({
      agent: "billing",
      run: "run-2",
      parent: "run-0",
      tools: ["refund_customer"],
    });
    expect(response.statusCode).toBe(200);
  });

  it("records the block as a violation, so it shows up in the feed", async () => {
    denyRefunds();
    await send({ agent: "support", tools: ["refund_customer"] });

    const violations = analytics.recentViolations("t1", 10);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.policyName).toBe("no refunds");
    expect(violations[0]?.reason).toContain("refund_customer");
  });

  /*
   * The one way a boundary could quietly stop holding is tool extraction being
   * switched off underneath it. That is caught at boot, not at request time.
   */
  describe("refusing to serve an unenforceable boundary", () => {
    it("throws at startup, naming the policy and both ways out", () => {
      denyRefunds();
      expect(() =>
        assertToolPoliciesEnforceable({ extractTools: false }, repository),
      ).toThrow(/no refunds/);
      expect(() =>
        assertToolPoliciesEnforceable({ extractTools: false }, repository),
      ).toThrow(/COSTGRID_EXTRACT_TOOLS=false|policy disable/);
    });

    it("starts normally when extraction is on", () => {
      denyRefunds();
      expect(() => assertToolPoliciesEnforceable({ extractTools: true }, repository)).not.toThrow();
    });

    it("starts normally with extraction off and no tool rules", () => {
      repository.createPolicy("t1", {
        name: "monthly cap",
        scope: { kind: "tenant" },
        rule: { kind: "max-output-tokens", limit: 4096 },
        action: "block",
        enabled: true,
      });
      expect(() => assertToolPoliciesEnforceable({ extractTools: false }, repository)).not.toThrow();
    });

    it("ignores a disabled tool rule, which enforces nothing by definition", () => {
      const id = denyRefunds();
      repository.setPolicyEnabled(id, false);
      expect(() => assertToolPoliciesEnforceable({ extractTools: false }, repository)).not.toThrow();
    });
  });
});

/**
 * Response-side gating: the second line, for a `tool_use` the request never
 * declared. Narrower than the request-side rule by design — that one prevents,
 * this one intercepts — and the two halves have genuinely different strength,
 * which these tests are written to pin.
 */
describe("gating a tool the model asked for but was never given", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;
  let app: FastifyInstance;
  let apiKey: string;
  let upstream: () => Response;

  const boot = () => {
    app = createServer({
      config: CONFIG,
      repository,
      analytics,
      imports: new ImportsRepository(db),
      fetchImpl: (async () => upstream()) as unknown as typeof fetch,
    });
  };

  const send = (over: { agent?: string; stream?: boolean; run?: string; parent?: string } = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "x-costgrid-key": apiKey,
        "x-costgrid-agent": over.agent ?? "support",
        ...(over.run ? { "x-costgrid-run": over.run } : {}),
        ...(over.parent ? { "x-costgrid-parent-run": over.parent } : {}),
      },
      // Note what is NOT here: no `tools`. The request declares nothing, so the
      // request-side rule has nothing to bite on. This is the case only
      // response-side gating can reach.
      payload: {
        model: "claude-haiku-4-5",
        max_tokens: 100,
        ...(over.stream ? { stream: true } : {}),
      },
    });

  /** A buffered reply in which the model invents a tool call. */
  const invents = (tool: string) =>
    new Response(
      JSON.stringify({
        model: "claude-haiku-4-5",
        stop_reason: "tool_use",
        usage: USAGE,
        content: [{ type: "tool_use", id: "t1", name: tool, input: { amount_usd: 420 } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  /** The same, streamed, with the name and its arguments in separate chunks. */
  const inventsStreaming = (tool: string) => {
    const chunks = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { model: "claude-haiku-4-5", usage: { input_tokens: 1000, output_tokens: 1 } },
      })}\n\n`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"${tool}"}}\n\n`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"amount_usd\\":420}"}}\n\n`,
      `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n`,
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    analytics = new Analytics(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    upstream = () => invents("refund_customer");
    boot();
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  const deny = (action: "monitor" | "warn" | "block" = "block") =>
    repository.createPolicy("t1", {
      name: "no refunds",
      scope: { kind: "agent", agentId: "support" },
      rule: { kind: "tool-denylist", tools: ["refund_customer"] },
      action,
      enabled: true,
    });

  // ------------------------------------------------------------- buffered

  it("withholds a buffered response that invents a denied tool", async () => {
    deny();
    const response = await send();

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error.type).toBe("costgrid_tool_blocked");
    // The arguments never reach the caller, so there is nothing to execute.
    expect(response.body).not.toContain("420");
  });

  it("tells the caller the call was billed, because it was", async () => {
    deny();
    const response = await send();
    expect(JSON.parse(response.body).error.message).toContain("billed");

    // And the row agrees: real usage, real cost, not a free block.
    const summary = analytics.summary("t1", { from: 0, to: Date.now() + 1000 });
    expect(summary.totalCost).toBeGreaterThan(0n);
  });

  it("records it in the same violation feed as everything else", async () => {
    deny();
    await send();

    const violations = analytics.recentViolations("t1", 10);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("the model asked to use refund_customer");
  });

  it("lets it through under monitor, and still records it", async () => {
    deny("monitor");
    const response = await send();

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("refund_customer");
    expect(analytics.recentViolations("t1", 10)).toHaveLength(1);
  });

  it("leaves a tool nobody denied alone", async () => {
    deny();
    upstream = () => invents("search_docs");
    const response = await send();
    expect(response.statusCode).toBe(200);
  });

  it("follows the delegation chain here too", async () => {
    deny();
    // A parent run belonging to `support`, then the denied call from a delegate
    // that no rule names directly.
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support", "x-costgrid-run": "r1" },
      payload: { model: "claude-haiku-4-5", max_tokens: 100 },
    });

    upstream = () => invents("refund_customer");
    const response = await send({ agent: "billing", run: "r2", parent: "r1" });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error.message).toContain("support");
  });

  // ------------------------------------------------------------ streaming

  it("cuts a stream before the tool arguments are sent", async () => {
    deny();
    upstream = () => inventsStreaming("refund_customer");
    const response = await send({ stream: true });

    // The name is already out — it arrives in the same chunk we cut on. The
    // arguments are not, and that is the difference that matters: a tool call
    // with no input is not executable.
    expect(response.body).not.toContain("420");
    expect(response.body).not.toContain("input_json_delta");
    expect(response.body).toContain("costgrid_tool_blocked");
    expect(response.body).toContain("no refunds");
  });

  it("streams an allowed tool through untouched", async () => {
    deny();
    upstream = () => inventsStreaming("search_docs");
    const response = await send({ stream: true });

    expect(response.body).toContain("input_json_delta");
    expect(response.body).toContain("420");
    expect(response.body).not.toContain("costgrid_tool_blocked");
  });

  it("streams normally when no tool rule is in force", async () => {
    upstream = () => inventsStreaming("refund_customer");
    const response = await send({ stream: true });

    expect(response.body).toContain("420");
    expect(response.body).not.toContain("costgrid_tool_blocked");
  });

  /*
   * The money is the point. A response-side block still cost the customer,
   * unlike a request-side one, and only `ok` rows are summed as spend — so
   * filing these as `blocked` would quietly drop real spend out of every
   * budget and every statement.
   */
  it("counts a cut stream as spend, because the provider will bill for it", async () => {
    deny();
    upstream = () => inventsStreaming("refund_customer");
    await send({ stream: true });

    const summary = analytics.summary("t1", { from: 0, to: Date.now() + 1000 });
    expect(summary.totalCost).toBeGreaterThan(0n);
    expect(summary.blockedCalls).toBe(0);
    expect(analytics.recentViolations("t1", 10)).toHaveLength(1);
  });

  it("does not cut under monitor", async () => {
    deny("monitor");
    upstream = () => inventsStreaming("refund_customer");
    const response = await send({ stream: true });

    expect(response.body).toContain("420");
    expect(analytics.recentViolations("t1", 10)).toHaveLength(1);
  });
});
