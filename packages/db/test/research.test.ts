import { randomUUID } from "node:crypto";
import { deriveMasterKey, priceUsage, type TokenUsage, usd, ZERO_USAGE } from "@costgrid/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AlertsRepository,
  Analytics,
  AuditLog,
  buildStatement,
  CostGridRepository,
  FixedCosts,
  Insights,
  MeasuredSavings,
  openDatabase,
  RuleRegister,
  trailingWindow,
  validateWebhookUrl,
} from "../src/index.js";

/**
 * The features added to close the gap between the research CostGrid cites and
 * what the product measured: run-cost spread, reasoning spend, measured
 * savings, full cost, the rule register and alerts.
 */

const T = "t1";
const DAY = 86_400_000;

describe("research-backed reporting", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    repository.createTenant("Acme", T);
  });
  afterEach(() => db.close());

  function call(input: {
    model: string;
    at: number;
    usage?: Partial<TokenUsage>;
    agentId?: string;
    runId?: string;
    reasoningTokens?: number;
    reasoningRequested?: string;
    requestedModel?: string;
    id?: string;
  }): string {
    const usage = { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 500, ...input.usage };
    const priced = priceUsage(input.model, usage);
    const id = input.id ?? randomUUID();
    repository.recordCall({
      id,
      tenantId: T,
      agentId: input.agentId ?? "support-bot",
      department: "Support",
      provider: priced.price?.provider ?? "anthropic",
      model: input.model,
      startedAt: input.at,
      durationMs: 5,
      streamed: false,
      usage,
      cost: priced.cost,
      priced: priced.priced,
      outcome: "ok",
      ...(input.runId ? { runId: input.runId, runDeclared: true } : {}),
      ...(input.reasoningTokens !== undefined ? { reasoningTokens: input.reasoningTokens } : {}),
      ...(input.reasoningRequested ? { reasoningRequested: input.reasoningRequested } : {}),
      ...(input.requestedModel ? { requestedModel: input.requestedModel, routed: true } : {}),
    });
    return id;
  }

  // ------------------------------------------------------------- run spread

  it("reports the typical and the bad run per agent, not an average", () => {
    const now = Date.now();
    // Nineteen ordinary runs of one call, and one runaway of thirty.
    for (let r = 0; r < 19; r += 1) call({ model: "claude-haiku-4-5", at: now - r * 1000, runId: `run-${r}` });
    for (let s = 0; s < 30; s += 1) call({ model: "claude-haiku-4-5", at: now - 50_000 - s, runId: "runaway" });

    const [spread] = new Insights(db).runSpread(T, trailingWindow(1, now));
    const one = priceUsage("claude-haiku-4-5", { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 500 }).cost.total;
    expect(spread).toMatchObject({ agentId: "support-bot", runs: 20, median: one, medianSteps: 1 });
    // Nearest-rank 95th percentile of 20 is the 19th value: still an ordinary run.
    expect(spread!.p95).toBe(one);
    expect(spread!.max).toBe(one * 30n);
    expect(spread!.p95Steps).toBe(1);
  });

  it("leaves runs CostGrid invented out of the spread", () => {
    call({ model: "claude-haiku-4-5", at: Date.now() });
    expect(new Insights(db).runSpread(T, trailingWindow(1))).toEqual([]);
  });

  // --------------------------------------------------------------- reasoning

  it("costs reported reasoning tokens exactly, at the output rate", () => {
    const now = Date.now();
    call({ model: "gpt-6-sol", at: now, usage: { outputTokens: 1_000 }, reasoningTokens: 800, reasoningRequested: "effort:high" });
    call({ model: "claude-opus-5-5", at: now, reasoningRequested: "effort:max" });

    const report = new Insights(db).reasoning(T, trailingWindow(1, now));
    const gpt = report.byModel.find((m) => m.model === "gpt-6-sol")!;
    // $10/MTok output, 800 reasoning tokens: $0.008 exactly.
    expect(gpt.reasoningCost).toBe(usd("0.008"));
    expect(gpt).toMatchObject({ reportedCalls: 1, reasoningTokens: 800, outputTokens: 1_000 });
    // Claude reports no split, so nothing is claimed for it.
    expect(report.byModel.find((m) => m.model === "claude-opus-5-5")).toMatchObject({ reportedCalls: 0, reasoningCost: 0n });
    expect(report.byRequest.map((r) => r.requested).sort()).toEqual(["effort:high", "effort:max"]);
    // 200 visible tokens after 800 of reasoning is not under the 200 threshold.
    expect(report.overthinking).toEqual([]);
  });

  it("flags short answers that followed long reasoning", () => {
    call({ model: "gpt-6-sol", at: Date.now(), usage: { outputTokens: 2_050 }, reasoningTokens: 2_000 });
    const [signal] = new Insights(db).reasoning(T, trailingWindow(1)).overthinking;
    expect(signal).toMatchObject({ agentId: "support-bot", calls: 1 });
  });

  // ---------------------------------------------------------- measured saving

  it("measures a switch that made things more expensive, which the estimate called a saving", () => {
    const live = Date.now() - 2 * DAY;
    const id = repository.createPolicy(
      T,
      {
        name: "cheaper model",
        scope: { kind: "agent", agentId: "support-bot" },
        rule: { kind: "route", toModel: "claude-haiku-4-5" },
        action: "block",
        enabled: true,
      },
      live,
    );

    // Before: 40 calls on Sonnet, 500 output tokens each.
    for (let i = 0; i < 40; i += 1) call({ model: "claude-sonnet-4-6", at: live - (i + 1) * 3_600_000 });
    // After: Haiku, cheaper per token, but each call writes twenty times as much.
    for (let i = 0; i < 40; i += 1) {
      const callId = call({
        model: "claude-haiku-4-5",
        at: live + (i + 1) * 60_000,
        usage: { outputTokens: 10_000 },
        requestedModel: "claude-sonnet-4-6",
      });
      repository.recordViolations(T, callId, [{ policyId: id, policyName: "cheaper model", action: "warn", reason: "routed" }]);
    }

    const entries = new RuleRegister(db, repository).entries(T, trailingWindow(30));
    const [m] = new MeasuredSavings(db).forPolicies(T, entries);
    expect(m).toMatchObject({ fromModel: "claude-sonnet-4-6", toModel: "claude-haiku-4-5", verdict: "more-expensive" });
    expect(m!.before.calls).toBe(40);
    expect(m!.after.outputTokensPerCall).toBe(10_000);
    expect(m!.changePerCall!).toBeGreaterThan(0);
    expect(m!.caveat).toMatch(/not a controlled experiment/);
  });

  it("says not enough data rather than a number on a thin sample", () => {
    const live = Date.now() - DAY;
    const id = repository.createPolicy(T, {
      name: "r",
      scope: { kind: "tenant" },
      rule: { kind: "route", toModel: "claude-haiku-4-5" },
      action: "block",
      enabled: true,
    }, live);
    const callId = call({ model: "claude-haiku-4-5", at: live + 1, requestedModel: "claude-sonnet-4-6" });
    repository.recordViolations(T, callId, [{ policyId: id, policyName: "r", action: "warn", reason: "routed" }]);
    const entries = new RuleRegister(db, repository).entries(T, trailingWindow(30));
    const [m] = new MeasuredSavings(db).forPolicies(T, entries);
    expect(m).toMatchObject({ verdict: "not-enough-data", changePerCall: null });
  });

  // -------------------------------------------------------------- full cost

  it("adds entered costs to the statement without mixing them into metered spend", () => {
    const fixed = new FixedCosts(db);
    fixed.add(T, { label: "Helpdesk licence", category: "subscriptions", scope: { kind: "tenant" }, monthlyAmount: usd("400"), startsMonth: "2026-09" });
    fixed.add(T, { label: "Old pilot", category: "platform", scope: { kind: "tenant" }, monthlyAmount: usd("99"), startsMonth: "2026-01", endsMonth: "2026-08" });
    call({ model: "claude-haiku-4-5", at: Date.UTC(2026, 9, 2) });
    repository.recordOutcome({ tenantId: T, runId: "nope", succeeded: true, at: Date.UTC(2026, 9, 2) });

    const s = buildStatement({
      analytics: new Analytics(db),
      repository,
      fixedCosts: fixed,
      tenantId: T,
      month: "2026-10",
      now: Date.UTC(2026, 9, 3),
    });
    expect(s.fixedCosts.total).toBe(usd("400"));
    expect(s.fixedCosts.lines).toHaveLength(1);
    expect(s.fullCost).toBe(s.total + usd("400"));
    expect(() => fixed.add(T, { label: "", category: "other", scope: { kind: "tenant" }, monthlyAmount: 1n, startsMonth: "2026-10" })).toThrow();
  });

  // ---------------------------------------------------------- rule register

  it("records owner, reason and when a rule went live, and moves it on re-enable", () => {
    const at = Date.now() - DAY;
    const id = repository.createPolicy(T, {
      name: "monthly cap",
      scope: { kind: "department", department: "Support" },
      rule: { kind: "budget", window: "month", limit: usd("500") },
      action: "block",
      enabled: true,
      owner: "finance@acme.test",
      reason: "pilot budget",
    }, at);
    const monitor = repository.createPolicy(T, {
      name: "measuring",
      scope: { kind: "tenant" },
      rule: { kind: "run-steps", limit: 50 },
      action: "monitor",
      enabled: true,
    });
    repository.recordViolations(T, "c1", [{ policyId: id, policyName: "monthly cap", action: "block", reason: "over" }]);
    new AuditLog(db).record(T, { actor: { kind: "user", id: "u", label: "a@acme.test" }, action: "policy.created", subject: id });

    const register = new RuleRegister(db, repository);
    const [cap, measuring] = register.entries(T, trailingWindow(30));
    expect(cap).toMatchObject({ owner: "finance@acme.test", reason: "pilot budget", liveSince: at, fired: { block: 1, warn: 0, monitor: 0 } });
    expect(cap!.history).toEqual([expect.objectContaining({ action: "policy.created", by: "a@acme.test" })]);
    expect(measuring).toMatchObject({ id: monitor, owner: null, liveSince: null });

    repository.setPolicyEnabled(id, false);
    repository.setPolicyEnabled(id, true, at + 5_000);
    expect(register.entries(T, trailingWindow(30))[0]!.liveSince).toBe(at + 5_000);
    expect(register.annotate(T, monitor, { owner: "ops@acme.test" })).toBe(true);
  });

  // ------------------------------------------------------------------ alerts

  it("raises each alert once, however many calls trip it", () => {
    const alerts = new AlertsRepository(db);
    const input = { kind: "blocked" as const, dedupeKey: "budget:p1:2026-10", subject: "bot", message: "over" };
    expect(alerts.raise(T, input)).toBeDefined();
    expect(alerts.raise(T, input)).toBeUndefined();
    expect(alerts.recent(T)).toHaveLength(1);
  });

  it("stores the alert address encrypted and only ever returns a hint", () => {
    const alerts = new AlertsRepository(db, deriveMasterKey("x".repeat(40)));
    const url = "https://hooks.slack.com/services/T000/B000/secretsecretabcd";
    const settings = alerts.configure(T, { webhookUrl: url, desktop: false });
    expect(settings).toEqual({ webhookConfigured: true, webhookHint: "hooks.slack.com/…abcd", desktop: false });
    const raw = db.prepare("SELECT encrypted_webhook AS e FROM alert_settings").get() as { e: string };
    expect(raw.e).not.toContain("secret");
    expect(alerts.webhookUrl(T)).toBe(url);
    expect(alerts.configure(T, { webhookUrl: null }).webhookConfigured).toBe(false);
  });

  it("refuses alert addresses that would send in clear text", () => {
    expect(() => validateWebhookUrl("http://hooks.example.com/x")).toThrow(/https/);
    expect(validateWebhookUrl("http://127.0.0.1:9000/hook")).toBe("http://127.0.0.1:9000/hook");
    expect(() => new AlertsRepository(db).configure(T, { webhookUrl: "https://a.test/x" })).toThrow(/master key/);
  });
});
