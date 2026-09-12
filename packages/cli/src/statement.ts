import { type Nanodollars, toUsdNumber, toUsdString } from "@costgrid/core";
import type { Statement, StatementLine } from "@costgrid/db";

function money(value: Nanodollars): string {
  const dollars = toUsdNumber(value);
  // Sub-cent totals are normal early on; showing "$0.00" would look like a bug.
  return dollars > 0 && dollars < 0.01 ? `$${toUsdString(value, 6)}` : `$${dollars.toFixed(2)}`;
}

/** A signed change, or a dash when there is nothing honest to compare against. */
function delta(change: number | undefined): string {
  if (change === undefined) return "     new";
  const pct = change * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`.padStart(8);
}

function table(rows: readonly StatementLine[]): string {
  if (rows.length === 0) return "  (nothing recorded)";
  const width = Math.max(...rows.map((r) => r.key.length));

  return rows
    .map(
      (row) =>
        `  ${row.key.padEnd(width)}  ${money(row.cost).padStart(11)}  ` +
        `${(row.share * 100).toFixed(1).padStart(5)}%  ${delta(row.change)}  ` +
        `${String(row.calls).padStart(6)} calls`,
    )
    .join("\n");
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(month: string): string {
  const [year, index] = month.split("-");
  return `${MONTH_NAMES[Number(index) - 1] ?? month} ${year}`;
}

/**
 * Render a month's statement for a human.
 *
 * The audience is a finance lead who did not choose CostGrid and will not open
 * the dashboard: they need the total, who spent it, how it moved, and what the
 * tool saved — in that order, on one screen. Anything the numbers do not cover
 * is stated rather than omitted, because a statement that quietly excludes
 * traffic is worse than one that admits it.
 */
export function formatStatement(statement: Statement): string {
  const out: string[] = [];
  const rule = "─".repeat(72);

  out.push("");
  out.push(`  CostGrid statement — ${monthLabel(statement.month)}`);
  out.push(`  ${rule}`);

  if (statement.partial) {
    const elapsed = statement.daysElapsed.toFixed(1);
    out.push(
      `  Month to date: ${elapsed} of ${statement.daysInMonth} days. Figures are not final.`,
    );
  }

  out.push("");
  out.push(`  Total spend        ${money(statement.total)}`);
  out.push(
    `  Previous month     ${money(statement.previousTotal)}` +
      (statement.change === undefined ? "" : `   (${delta(statement.change).trim()})`),
  );
  if (statement.projected !== undefined) {
    out.push(`  Projected month    ${money(statement.projected)}  (run rate so far)`);
  }
  out.push(`  Calls              ${statement.calls.toLocaleString("en-US")}`);
  out.push(`  Cache hit ratio    ${(statement.cacheHitRatio * 100).toFixed(1)}%`);

  if (statement.routing.routedCalls > 0) {
    out.push(
      `  Saved by routing   ${money(statement.routing.realisedSaving)} across ` +
        `${statement.routing.routedCalls} rerouted call(s)`,
    );
  }

  out.push("");
  out.push("  By department");
  out.push(table(statement.byDepartment));
  out.push("");
  out.push("  By agent");
  out.push(table(statement.byAgent));
  out.push("");
  out.push("  By model");
  out.push(table(statement.byModel));

  if (statement.budgets.length > 0) {
    out.push("");
    out.push("  Budgets");
    for (const budget of statement.budgets) {
      const used = budget.used === undefined ? "  n/a" : `${(budget.used * 100).toFixed(0)}%`;
      const basis =
        budget.window === "day"
          ? `worst day ${money(budget.actual)} vs ${money(budget.limit)}/day`
          : `${money(budget.actual)} of ${money(budget.limit)}`;
      const over =
        budget.breachedDays !== undefined && budget.breachedDays > 0
          ? ` — over on ${budget.breachedDays} day(s)`
          : "";
      const fallback = budget.fallbackModel ? `, falls back to ${budget.fallbackModel}` : "";
      out.push(
        `    ${used.padStart(5)}  ${budget.scope.padEnd(24)} ${basis} ` +
          `[${budget.action}${fallback}]${over}`,
      );
    }
  }

  // --- what these numbers do not include ---------------------------------
  const caveats: string[] = [];
  if (statement.unpricedCalls > 0) {
    caveats.push(
      `${statement.unpricedCalls} call(s) used a model missing from the price catalog and ` +
        "are counted as $0 — the total above is understated.",
    );
  }
  if (statement.blockedCalls > 0) {
    caveats.push(
      `${statement.blockedCalls} call(s) were refused by policy. They cost nothing, and what ` +
        "they would have cost cannot be measured because they never ran.",
    );
  }
  if (statement.erroredCalls > 0) {
    caveats.push(`${statement.erroredCalls} call(s) failed upstream and are not billed here.`);
  }
  if (statement.imported !== undefined) {
    const cost = statement.imported.reportedCost ?? statement.imported.catalogCost;
    caveats.push(
      `${money(cost)} of provider-reported history was imported for this month. It is shown ` +
        "separately, not added: those rows are daily provider totals with no team attribution.",
    );
  }

  if (caveats.length > 0) {
    out.push("");
    out.push("  Notes");
    for (const caveat of caveats) out.push(`    • ${caveat}`);
  }

  out.push("");
  out.push(`  Generated ${new Date(statement.generatedAt).toISOString()} from metered calls.`);
  out.push("");
  return out.join("\n");
}
