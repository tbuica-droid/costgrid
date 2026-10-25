import { type Nanodollars, type PolicyScope, toUsdString, usd } from "@costgrid/core";
import {
  type AccountsRepository,
  type AlertsRepository,
  type Analytics,
  AuditLog,
  buildStatement,
  type CostGridRepository,
  type Db,
  FIXED_COST_CATEGORIES,
  FixedCosts,
  type ImportsRepository,
  Insights,
  isFixedCostCategory,
  MeasuredSavings,
  monthOf,
  RuleRegister,
  type Statement,
  trailingWindow,
  jobsView,
  RunOutcomes,
} from "@costgrid/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type ConsoleRequest, createGuards } from "./console.js";
import { ruleView } from "./console-limits.js";

/**
 * The Results screen: what the money bought, and what it all really costs.
 *
 * Spend alone cannot say whether AI is worth it. This screen puts beside it
 * the four things the research says to look at instead:
 *
 *   - **Cost per result that worked**, from outcomes the customer's software
 *     reports (EY: every agent needs a value measure; Curcio's LCOAI divides
 *     cost by *valid* output, arXiv:2509.02596).
 *   - **How much a run costs, typical and worst**, because runs of the same
 *     task vary by up to 30x (arXiv:2604.22750).
 *   - **Where reasoning money goes** (arXiv:2603.23971, arXiv:2506.06941).
 *   - **The full monthly cost**, metered spend plus the entered costs that
 *     never reach a model provider's invoice (EY's seven categories).
 *
 * And the evidence pack: one file holding the statement, the rule register,
 * the alerts sent and the audit log's verification, for whoever has to show
 * an auditor that the controls exist and were used.
 */

export interface ResultsDeps {
  readonly db: Db;
  readonly accounts: AccountsRepository;
  readonly repository: CostGridRepository;
  readonly analytics: Analytics;
  readonly imports: ImportsRepository;
  readonly alerts: AlertsRepository;
}

const money = (value: Nanodollars): string => toUsdString(value, 6);
const optionalMoney = (value: Nanodollars | undefined | null): string | null =>
  value === undefined || value === null ? null : money(value);

function days(request: FastifyRequest): number {
  const raw = (request.query as Record<string, unknown> | undefined)?.["days"];
  if (raw === undefined || raw === "") return 30;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw Object.assign(new Error("days must be an integer between 1 and 365"), { statusCode: 400 });
  }
  return value;
}

function monthParam(request: FastifyRequest): string {
  const raw = (request.query as Record<string, unknown> | undefined)?.["month"];
  if (raw === undefined || raw === "") return monthOf();
  if (typeof raw !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
    throw Object.assign(new Error("month must be YYYY-MM"), { statusCode: 400 });
  }
  return raw;
}

function fullCostView(s: Statement): Record<string, unknown> {
  return {
    month: s.month,
    partial: s.partial,
    meteredUsd: money(s.total),
    enteredUsd: money(s.fixedCosts.total),
    fullCostUsd: money(s.fullCost),
    fullCostPerSuccessUsd: optionalMoney(s.fullCostPerSuccess),
    entered: s.fixedCosts.lines.map((l) => ({ ...l, amount: undefined, amountUsd: money(l.amount) })),
  };
}

export function registerResults(app: FastifyInstance, deps: ResultsDeps): void {
  const { accounts, alerts, analytics, db, imports, repository } = deps;
  const { audit } = accounts;
  const { requireRole } = createGuards(accounts);
  const insights = new Insights(db);
  const fixedCosts = new FixedCosts(db);
  const register = new RuleRegister(db, repository);
  const measured = new MeasuredSavings(db);
  const runOutcomes = new RunOutcomes(db);
  const bad = (reply: FastifyReply, error: string) => reply.code(400).send({ error });

  app.get("/console/:tenantId/results", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    if (!requireRole(request, reply, tenantId)) return;

    const window = days(request);
    const range = trailingWindow(window);
    const o = analytics.outcomes(tenantId, range);
    const reasoning = insights.reasoning(tenantId, range);
    const statement = buildStatement({ analytics, repository, imports, fixedCosts, tenantId });

    return {
      days: window,
      outcomes: {
        reportedRuns: o.reportedRuns,
        succeeded: o.succeeded,
        failed: o.failed,
        costOfSuccessUsd: money(o.costOfSuccess),
        costOfFailureUsd: money(o.costOfFailure),
        costPerSuccessUsd: optionalMoney(o.costPerSuccess),
        totalRuns: o.totalRuns,
        truncatedRuns: o.truncatedRuns,
        erroredRuns: o.erroredRuns,
        runSpendUsd: money(o.runSpend),
      },
      runSpread: insights.runSpread(tenantId, range).map((r) => ({
        agentId: r.agentId,
        runs: r.runs,
        medianUsd: money(r.median),
        p95Usd: money(r.p95),
        maxUsd: money(r.max),
        meanUsd: money(r.mean),
        medianSteps: r.medianSteps,
        p95Steps: r.p95Steps,
      })),
      reasoning: {
        byModel: reasoning.byModel.map((r) => ({
          ...r,
          cost: undefined,
          reasoningCost: undefined,
          costUsd: money(r.cost),
          reasoningCostUsd: money(r.reasoningCost),
        })),
        byRequest: reasoning.byRequest.map((r) => ({ ...r, cost: undefined, costUsd: money(r.cost) })),
        overthinking: reasoning.overthinking.map((r) => ({
          ...r,
          reasoningCost: undefined,
          reasoningCostUsd: money(r.reasoningCost),
        })),
      },
      fullCost: fullCostView(statement),
      fixedCosts: fixedCosts.list(tenantId).map((c) => ({
        ...c,
        monthlyAmount: undefined,
        monthlyAmountUsd: money(c.monthlyAmount),
      })),
      categories: FIXED_COST_CATEGORIES,
    };
  });

  app.post("/console/:tenantId/fixed-costs", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const amount = body["monthlyUsd"];
    if (typeof amount !== "string" || !/^\d+(\.\d{1,2})?$/.test(amount.trim())) {
      return bad(reply, "the monthly amount must be a number of dollars, like 400 or 1250.50");
    }
    if (!isFixedCostCategory(body["category"])) return bad(reply, "choose a category");
    const rawScope = body["scope"] as Record<string, unknown> | undefined;
    const scope: PolicyScope =
      rawScope?.["kind"] === "department" && typeof rawScope["department"] === "string"
        ? { kind: "department", department: rawScope["department"].trim().slice(0, 128) }
        : rawScope?.["kind"] === "agent" && typeof rawScope["agentId"] === "string"
          ? { kind: "agent", agentId: rawScope["agentId"].trim().slice(0, 128) }
          : { kind: "tenant" };

    let id: string;
    try {
      id = fixedCosts.add(tenantId, {
        label: typeof body["label"] === "string" ? body["label"] : "",
        category: body["category"],
        scope,
        monthlyAmount: usd(amount.trim()),
        startsMonth: typeof body["startsMonth"] === "string" ? body["startsMonth"] : monthOf(),
        endsMonth: typeof body["endsMonth"] === "string" && body["endsMonth"] !== "" ? body["endsMonth"] : null,
      });
    } catch (error) {
      return bad(reply, error instanceof Error ? error.message : "invalid cost");
    }
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "cost.entered",
      subject: id,
      detail: { category: String(body["category"]), monthlyUsd: amount.trim() },
    });
    return reply.code(201).send({ id });
  });

  app.delete("/console/:tenantId/fixed-costs/:costId", async (request: ConsoleRequest, reply) => {
    const { tenantId, costId } = request.params as { tenantId: string; costId: string };
    const actor = requireRole(request, reply, tenantId, "owner");
    if (!actor) return;
    if (!fixedCosts.remove(tenantId, costId)) return reply.code(404).send({ error: "no such cost" });
    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "cost.removed",
      subject: costId,
    });
    return { removed: true };
  });

  /**
   * The evidence pack: one month, everything an auditor would ask for.
   *
   * JSON so it can be checked by a program as well as read. Contains no
   * prompts, responses or credentials, because CostGrid stores none.
   */
  app.get("/console/:tenantId/evidence", async (request: ConsoleRequest, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const actor = requireRole(request, reply, tenantId);
    if (!actor) return;

    const month = monthParam(request);
    const s = buildStatement({ analytics, repository, imports, fixedCosts, tenantId, month, runOutcomes });
    const entries = register.entries(tenantId, s.range);
    const log = new AuditLog(db);
    const verification = log.verify(tenantId);
    const head = log.head(tenantId);

    audit.record(tenantId, {
      actor: { kind: "user", id: actor.user.id, label: actor.user.email },
      action: "evidence.exported",
      subject: month,
    });

    const pack = {
      kind: "costgrid-evidence-pack",
      version: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: actor.user.email,
      month: s.month,
      complete: !s.partial,
      statement: {
        meteredUsd: money(s.total),
        enteredUsd: money(s.fixedCosts.total),
        fullCostUsd: money(s.fullCost),
        calls: s.calls,
        blockedCalls: s.blockedCalls,
        unpricedCalls: s.unpricedCalls,
        byDepartment: s.byDepartment.map((l) => ({ key: l.key, calls: l.calls, costUsd: money(l.cost) })),
        byAgent: s.byAgent.map((l) => ({ key: l.key, calls: l.calls, costUsd: money(l.cost) })),
        byModel: s.byModel.map((l) => ({ key: l.key, calls: l.calls, costUsd: money(l.cost) })),
        budgets: s.budgets.map((b) => ({ ...b, limit: money(b.limit), actual: money(b.actual) })),
        outcomes: {
          reportedRuns: s.outcomes.reportedRuns,
          succeeded: s.outcomes.succeeded,
          costPerSuccessUsd: optionalMoney(s.outcomes.costPerSuccess),
          fullCostPerSuccessUsd: optionalMoney(s.fullCostPerSuccess),
        },
        entered: fullCostView(s)["entered"],
        jobs: jobsView(s.jobs),
      },
      ruleRegister: entries.map((e) => ({ ...e, rule: ruleView(e.rule) })),
      measuredSwitches: measured.forPolicies(tenantId, entries).map((m) => ({
        policy: m.policyName,
        from: m.fromModel,
        to: m.toModel,
        verdict: m.verdict,
        changePerCall: m.changePerCall,
        changePerRun: m.changePerRun,
        caveat: m.caveat,
      })),
      alerts: alerts
        .recent(tenantId, 500)
        .filter((a) => a.occurredAt >= s.range.from && a.occurredAt < s.range.to),
      auditLog: {
        // Verification over the whole log, and its fingerprint: write the head
        // down somewhere CostGrid cannot reach and any later edit is provable.
        verification,
        head,
      },
      frameworks: {
        nistAiRmf: "https://costgrid.dev/research.html#nist",
      },
    };

    return reply
      .header("content-type", "application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="costgrid-evidence-${month}.json"`)
      .send(JSON.stringify(pack, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
  });
}
