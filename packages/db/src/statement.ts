import { type Nanodollars, type PolicyScope, toUsdString } from "@costgrid/core";
import type { Analytics, GroupedSpend, RoutingSavings, TimeRange } from "./analytics.js";
import type { ImportsRepository } from "./imports.js";
import type { CostGridRepository } from "./repositories.js";

/**
 * The monthly statement: the artifact a customer forwards to finance.
 *
 * Everything here is derived from the same metered calls the dashboard shows.
 * It exists as its own module because a statement is a *closed period* — a
 * calendar month in UTC, comparable against the one before it — whereas every
 * other view in CostGrid is a trailing window. The two answer different
 * questions and must not be conflated: "the last 30 days" and "September" are
 * never the same number, and a finance team reconciling against a provider
 * invoice needs the second one.
 */

/** A `YYYY-MM` calendar month, as a half-open UTC range. */
export function monthRange(month: string): TimeRange {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new RangeError(`month must be YYYY-MM, got ${JSON.stringify(month)}`);
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11) throw new RangeError(`month must be 01..12, got ${month}`);
  return {
    from: Date.UTC(year, index, 1),
    to: Date.UTC(year, index + 1, 1),
  };
}

/** The `YYYY-MM` the given instant falls in, in UTC. */
export function monthOf(at: number | Date = Date.now()): string {
  const date = new Date(at);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The calendar month before this one. */
export function previousMonth(month: string): string {
  const { from } = monthRange(month);
  return monthOf(new Date(from).setUTCDate(0));
}

export interface StatementLine {
  readonly key: string;
  readonly cost: Nanodollars;
  readonly calls: number;
  /** Fraction of the month's total, 0..1. */
  readonly share: number;
  readonly previousCost: Nanodollars;
  /**
   * Fractional change against the same line last month. `undefined` when there
   * is nothing to compare against — a line that did not exist last month has
   * not grown by infinity, and printing a percentage there would be a lie.
   */
  readonly change: number | undefined;
}

export interface BudgetStatus {
  readonly policyId: string;
  readonly policyName: string;
  readonly scope: string;
  readonly window: "day" | "month";
  readonly action: string;
  readonly limit: Nanodollars;
  /** Month spend for a monthly cap; the worst single day for a daily one. */
  readonly actual: Nanodollars;
  /** `actual / limit`, or `undefined` for a zero limit. */
  readonly used: number | undefined;
  /** Daily caps only: how many days in the month exceeded the limit. */
  readonly breachedDays: number | undefined;
  readonly fallbackModel: string | undefined;
}

export interface Statement {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly range: TimeRange;
  readonly generatedAt: number;
  /** True when the month has not finished; the totals are month-to-date. */
  readonly partial: boolean;
  readonly daysElapsed: number;
  readonly daysInMonth: number;

  readonly total: Nanodollars;
  readonly previousTotal: Nanodollars;
  readonly change: number | undefined;
  /**
   * Month-end total implied by the run rate so far. Present only for a partial
   * month, and explicitly a projection rather than a measurement.
   */
  readonly projected: Nanodollars | undefined;

  readonly calls: number;
  readonly blockedCalls: number;
  readonly erroredCalls: number;
  readonly unpricedCalls: number;
  readonly cacheHitRatio: number;

  readonly byDepartment: readonly StatementLine[];
  readonly byAgent: readonly StatementLine[];
  readonly byModel: readonly StatementLine[];

  readonly routing: RoutingSavings;
  readonly budgets: readonly BudgetStatus[];

  /**
   * Provider-reported history for the same month, when any has been imported.
   *
   * Kept apart from the metered figures rather than added to them: imported
   * rows are daily provider totals with no agent or department attribution, so
   * folding them into the chargeback tables would silently misattribute them.
   * Shown so the totals can be reconciled, not to pad them.
   */
  readonly imported:
    | { readonly catalogCost: Nanodollars; readonly reportedCost: Nanodollars | undefined; readonly requests: number }
    | undefined;
}

function describeScope(scope: PolicyScope): string {
  switch (scope.kind) {
    case "tenant":
      return "whole account";
    case "department":
      return `dept:${scope.department}`;
    case "agent":
      return `agent:${scope.agentId}`;
  }
}

function toLines(
  current: readonly GroupedSpend[],
  previous: readonly GroupedSpend[],
  total: Nanodollars,
): StatementLine[] {
  const before = new Map(previous.map((row) => [row.key, row.cost]));
  return current.map((row) => {
    const previousCost = before.get(row.key) ?? 0n;
    return {
      key: row.key,
      cost: row.cost,
      calls: row.calls,
      share: total > 0n ? Number(row.cost) / Number(total) : 0,
      previousCost,
      change: previousCost > 0n ? Number(row.cost - previousCost) / Number(previousCost) : undefined,
    };
  });
}

export interface StatementInput {
  readonly analytics: Analytics;
  readonly repository: CostGridRepository;
  readonly imports?: ImportsRepository;
  readonly tenantId: string;
  /** `YYYY-MM`. Defaults to the current month. */
  readonly month?: string;
  readonly now?: number;
}

/**
 * Assemble a month's statement.
 *
 * Reads only; safe to run against a live database while the gateway is
 * metering into it.
 */
export function buildStatement(input: StatementInput): Statement {
  const now = input.now ?? Date.now();
  const month = input.month ?? monthOf(now);
  const range = monthRange(month);
  const prior = monthRange(previousMonth(month));

  const { analytics, repository, tenantId } = input;
  const summary = analytics.summary(tenantId, range);
  const previousSummary = analytics.summary(tenantId, prior);

  const daysInMonth = Math.round((range.to - range.from) / 86_400_000);
  const partial = now < range.to;
  // A month that has not started yet has zero days elapsed, not a negative
  // number, and must never produce a projection.
  const elapsedMs = Math.min(Math.max(now - range.from, 0), range.to - range.from);
  const daysElapsed = partial ? Math.max(elapsedMs / 86_400_000, 0) : daysInMonth;

  const projected =
    partial && daysElapsed > 0
      ? (summary.totalCost * BigInt(Math.round(daysInMonth * 1000))) /
        BigInt(Math.round(daysElapsed * 1000))
      : undefined;

  const budgets: BudgetStatus[] = [];
  for (const policy of repository.listPolicies(tenantId)) {
    if (!policy.enabled || policy.rule.kind !== "budget") continue;
    const rule = policy.rule;
    const scoped = analytics.spendInRange(tenantId, range, policy.scope);
    const actual =
      rule.window === "month"
        ? scoped.total
        : scoped.days.reduce((worst, day) => (day.cost > worst ? day.cost : worst), 0n);

    budgets.push({
      policyId: policy.id,
      policyName: policy.name,
      scope: describeScope(policy.scope),
      window: rule.window,
      action: policy.action,
      limit: rule.limit,
      actual,
      used: rule.limit > 0n ? Number(actual) / Number(rule.limit) : undefined,
      breachedDays:
        rule.window === "day" ? scoped.days.filter((d) => d.cost > rule.limit).length : undefined,
      fallbackModel: rule.fallbackModel,
    });
  }

  const importedSummary = input.imports?.summary(tenantId, range);

  return {
    month,
    range,
    generatedAt: now,
    partial,
    daysElapsed,
    daysInMonth,

    total: summary.totalCost,
    previousTotal: previousSummary.totalCost,
    change:
      previousSummary.totalCost > 0n
        ? Number(summary.totalCost - previousSummary.totalCost) / Number(previousSummary.totalCost)
        : undefined,
    projected,

    calls: summary.calls,
    blockedCalls: summary.blockedCalls,
    erroredCalls: summary.erroredCalls,
    unpricedCalls: summary.unpricedCalls,
    cacheHitRatio: summary.cacheHitRatio,

    byDepartment: toLines(
      analytics.spendByDepartment(tenantId, range),
      analytics.spendByDepartment(tenantId, prior),
      summary.totalCost,
    ),
    byAgent: toLines(
      analytics.spendByAgent(tenantId, range),
      analytics.spendByAgent(tenantId, prior),
      summary.totalCost,
    ),
    byModel: toLines(
      analytics.spendByModel(tenantId, range),
      analytics.spendByModel(tenantId, prior),
      summary.totalCost,
    ),

    routing: analytics.routingSavings(tenantId, range),
    budgets,
    imported:
      importedSummary && importedSummary.rows > 0
        ? {
            catalogCost: importedSummary.catalogCost,
            reportedCost: importedSummary.reportedCost,
            requests: importedSummary.requests,
          }
        : undefined,
  };
}

// ---------------------------------------------------------------------- CSV

/**
 * Quote a CSV field.
 *
 * Department and agent names are customer-supplied, so a team called
 * "Sales, EMEA" would silently split into two columns without this — the kind
 * of corruption nobody notices until the totals stop adding up.
 */
function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(fields: readonly (string | number)[]): string {
  return fields.map(csvField).join(",");
}

const money = (amount: Nanodollars): string => toUsdString(amount, 6);
const percent = (fraction: number | undefined): string =>
  fraction === undefined ? "" : (fraction * 100).toFixed(1);

/**
 * The statement as CSV, for the spreadsheet a finance team actually works in.
 *
 * Two tables separated by a blank line: spend line items, then budget status.
 * Costs carry six decimal places rather than two — a $0.004 agent is a real
 * line, and rounding it to `0.00` on the way out would make the rows stop
 * summing to the total.
 */
export function statementToCsv(statement: Statement): string {
  const lines: string[] = [
    csvRow(["CostGrid statement", statement.month]),
    csvRow(["Generated", new Date(statement.generatedAt).toISOString()]),
    csvRow(["Status", statement.partial ? "month to date" : "complete"]),
    "",
    csvRow(["section", "item", "calls", "cost_usd", "share_pct", "previous_cost_usd", "change_pct"]),
    csvRow([
      "total",
      "all spend",
      statement.calls,
      money(statement.total),
      "100.0",
      money(statement.previousTotal),
      percent(statement.change),
    ]),
  ];

  const section = (name: string, rows: readonly StatementLine[]): void => {
    for (const row of rows) {
      lines.push(
        csvRow([
          name,
          row.key,
          row.calls,
          money(row.cost),
          percent(row.share),
          money(row.previousCost),
          percent(row.change),
        ]),
      );
    }
  };

  section("department", statement.byDepartment);
  section("agent", statement.byAgent);
  section("model", statement.byModel);

  lines.push(
    csvRow([
      "saving",
      "realised by auto-routing",
      statement.routing.routedCalls,
      money(statement.routing.realisedSaving),
      "",
      "",
      "",
    ]),
  );

  if (statement.imported !== undefined) {
    // Reported separately, never added: imported rows are daily provider
    // totals with no attribution, so they cannot appear in the tables above.
    lines.push(
      csvRow([
        "imported",
        "provider-reported history (unattributed)",
        statement.imported.requests,
        money(statement.imported.reportedCost ?? statement.imported.catalogCost),
        "",
        "",
        "",
      ]),
    );
  }

  if (statement.budgets.length > 0) {
    lines.push(
      "",
      csvRow(["budget", "scope", "window", "action", "limit_usd", "actual_usd", "used_pct", "days_over"]),
    );
    for (const budget of statement.budgets) {
      lines.push(
        csvRow([
          budget.policyName,
          budget.scope,
          budget.window,
          budget.action,
          money(budget.limit),
          money(budget.actual),
          percent(budget.used),
          budget.breachedDays ?? "",
        ]),
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
