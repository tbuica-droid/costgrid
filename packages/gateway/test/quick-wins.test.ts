import { ZERO_USAGE, type Policy } from "@costgrid/core";
import {
  Advisor,
  AlertsRepository,
  Analytics,
  AuditLog,
  type CallRecord,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
  QuickWins,
  RuleRegister,
} from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Alerter } from "../src/alerts.js";
import type { GatewayConfig } from "../src/config.js";
import { reviewQuickWins } from "../src/quick-win-review.js";
import { createServer } from "../src/server.js";

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

const DAY = 86_400_000;

describe("quick wins", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let app: FastifyInstance;
  let apiKey: string;
  let sent: Record<string, unknown>[];

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    sent = [];
    app = createServer({
      config: CONFIG,
      db,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        return new Response(
          JSON.stringify({ model: body["model"], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const send = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support" },
      payload: { model: "claude-sonnet-4-6", max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...payload },
    });

  const rule = (r: Policy["rule"], action: Policy["action"] = "warn", at = Date.now()) =>
    repository.createPolicy(
      "t1",
      { name: r.kind, scope: { kind: "agent", agentId: "support" }, rule: r, action, enabled: true },
      at,
    );

  const adjustments = () =>
    db.prepare("SELECT policy_id AS policyId, kind, change, applied FROM call_adjustments").all();

  // ----------------------------------------------------------------- proxy

  it("lowers reasoning on the way out, says so, and records it against the call", async () => {
    const id = rule({ kind: "lower-reasoning", effort: "low" });
    const res = await send({ output_config: { effort: "high" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-costgrid-adjusted"]).toBe("effort:high->low");
    expect(sent[0]!["output_config"]).toEqual({ effort: "low" });
    expect(adjustments()).toEqual([{ policyId: id, kind: "lower-reasoning", change: "effort:high->low", applied: 1 }]);
    // What the caller asked for is kept as asked.
    const call = db.prepare("SELECT reasoning_requested AS r FROM calls").get() as { r: string };
    expect(call.r).toBe("effort:high");
  });

  it("adds cache breakpoints, and a dry run changes nothing but records what it would have", async () => {
    rule({ kind: "add-cache" }, "monitor");
    const res = await send({ system: "You are a support agent." });
    expect(res.headers["x-costgrid-adjusted"]).toBeUndefined();
    expect(sent[0]!["system"]).toBe("You are a support agent.");
    expect(adjustments()).toMatchObject([{ kind: "add-cache", change: "cache:system", applied: 0 }]);
  });

  it("leaves other agents' calls alone", async () => {
    rule({ kind: "add-cache" });
    await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "sales" },
      payload: { model: "claude-sonnet-4-6", max_tokens: 100, system: "s", messages: [] },
    });
    expect(sent[0]!["system"]).toBe("s");
    expect(adjustments()).toEqual([]);
  });

  // ----------------------------------------------------------- measurement

  function call(over: Partial<CallRecord> & { costTotal: bigint; startedAt: number }): CallRecord {
    const { costTotal, ...rest } = over;
    return {
      id: crypto.randomUUID(),
      tenantId: "t1",
      agentId: "support",
      department: "default",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      durationMs: 10,
      streamed: false,
      usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 10 },
      cost: { input: costTotal, output: 0n, cacheWrite: 0n, cacheRead: 0n, total: costTotal },
      priced: true,
      outcome: "ok",
      ...rest,
    };
  }

  function seed(liveSince: number, policyId: string, before: bigint, after: bigint): void {
    for (let i = 0; i < 30; i += 1) {
      repository.recordCall(call({ costTotal: before, startedAt: liveSince - DAY + i, reasoningRequested: "effort:high" }));
      // Asked for no more than the rule allows: not part of the before cohort.
      repository.recordCall(call({ costTotal: 1n, startedAt: liveSince - DAY + i, reasoningRequested: "effort:low" }));
      repository.recordCall(
        call({
          costTotal: after,
          startedAt: liveSince + 1000 + i,
          reasoningRequested: "effort:high",
          adjustments: [{ policyId, policyName: "x", kind: "lower-reasoning", applied: true, change: "effort:high->low" }],
        }),
      );
    }
  }

  const entries = () => new RuleRegister(db, repository).entries("t1", { from: 0, to: Date.now() + DAY });

  it("measures before and after on the calls the rule would have changed", () => {
    const liveSince = Date.now() - 2 * DAY;
    const id = rule({ kind: "lower-reasoning", effort: "low" }, "warn", liveSince);
    seed(liveSince, id, 10_000n, 6_000n);
    const [m] = new QuickWins(db).measure("t1", entries(), Date.now());
    expect(m).toMatchObject({ policyId: id, verdict: "cheaper", before: { calls: 30, costPerCall: 10_000n } });
    expect(m!.after).toMatchObject({ calls: 30, costPerCall: 6_000n });
    expect(m!.changePerCall).toBeCloseTo(-0.4);
    // The register counts the changes as firings.
    expect(entries().find((e) => e.id === id)!.fired.warn).toBe(30);
  });

  it("says not enough data below thirty calls a side, and skips rules never switched on", () => {
    const liveSince = Date.now() - DAY;
    const id = rule({ kind: "lower-reasoning", effort: "low" }, "warn", liveSince);
    repository.recordCall(call({ costTotal: 5n, startedAt: liveSince - 10, reasoningRequested: "effort:high" }));
    rule({ kind: "add-cache" }, "monitor");
    const list = new QuickWins(db).measure("t1", entries(), Date.now());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ policyId: id, verdict: "not-enough-data", changePerCall: null });
  });

  it("switches a rule that costs more back to a dry run, with an audit entry and an alert", async () => {
    const liveSince = Date.now() - 2 * DAY;
    const id = rule({ kind: "lower-reasoning", effort: "low" }, "warn", liveSince);
    seed(liveSince, id, 6_000n, 10_000n);
    const alerts = new AlertsRepository(db, undefined);
    const switched = await reviewQuickWins({
      db,
      audit: new AuditLog(db),
      alerter: new Alerter({ alerts }),
    });
    expect(switched).toEqual([id]);
    expect(repository.listPolicies("t1").find((p) => p.id === id)!.action).toBe("monitor");
    const audit = db.prepare("SELECT action FROM audit_log WHERE subject = ?").all(id) as { action: string }[];
    expect(audit.map((a) => a.action)).toContain("policy.quick-win-reverted");
    expect(alerts.recent("t1", 10).map((a) => a.kind)).toEqual(["switched-back"]);
    // Nothing left to do on the next run.
    expect(await reviewQuickWins({ db, audit: new AuditLog(db) })).toEqual([]);
  });

  it("leaves a rule that pays alone", async () => {
    const liveSince = Date.now() - 2 * DAY;
    const id = rule({ kind: "lower-reasoning", effort: "low" }, "warn", liveSince);
    seed(liveSince, id, 10_000n, 6_000n);
    expect(await reviewQuickWins({ db, audit: new AuditLog(db) })).toEqual([]);
    expect(repository.listPolicies("t1")[0]!.action).toBe("warn");
  });

  it("moving a dry run to acting starts its live period", () => {
    const id = rule({ kind: "add-cache" }, "monitor", 1000);
    repository.setPolicyAction(id, "warn", 5000);
    const live = () => (db.prepare("SELECT live_since AS l, action FROM policies WHERE id = ?").get(id) as { l: number; action: string });
    expect(live()).toEqual({ l: 5000, action: "warn" });
    repository.setPolicyAction(id, "monitor", 9000);
    expect(live()).toEqual({ l: 5000, action: "monitor" });
  });

  // ---------------------------------------------------------------- advice

  it("suggests caching for a Claude agent re-sending a large prompt", () => {
    const now = Date.now();
    for (let i = 0; i < 25; i += 1) {
      repository.recordCall(
        call({ costTotal: 1_000_000_000n, startedAt: now - DAY + i, usage: { ...ZERO_USAGE, inputTokens: 9_000, outputTokens: 50 } }),
      );
    }
    const proposal = new Advisor(db)
      .proposals("t1", { from: now - 2 * DAY, to: now + 1 })
      .find((p) => p.kind === "cache-opportunity");
    expect(proposal).toMatchObject({
      rule: { kind: "add-cache" },
      command: "costgrid policy cache agent:support --action monitor",
    });
  });

  it("suggests one effort level lower for an agent that overthinks", () => {
    const now = Date.now();
    for (let i = 0; i < 25; i += 1) {
      repository.recordCall(
        call({
          provider: "openai",
          model: "gpt-5",
          costTotal: 1_000_000_000n,
          cost: { input: 0n, output: 1_000_000_000n, cacheWrite: 0n, cacheRead: 0n, total: 1_000_000_000n },
          startedAt: now - DAY + i,
          usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 2_100 },
          reasoningTokens: 2_000,
          reasoningRequested: "effort:high",
        }),
      );
    }
    const proposal = new Advisor(db)
      .proposals("t1", { from: now - 2 * DAY, to: now + 1 })
      .find((p) => p.kind === "lower-reasoning");
    expect(proposal).toMatchObject({
      rule: { kind: "lower-reasoning", effort: "medium" },
      command: "costgrid policy lower-reasoning agent:support --effort medium --action monitor",
    });
  });
});
