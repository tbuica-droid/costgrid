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
