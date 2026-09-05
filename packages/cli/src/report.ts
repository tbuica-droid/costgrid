import { analyzeRouting, type Nanodollars, toUsdNumber, toUsdString } from "@costgrid/core";
import type { Analytics, TimeRange } from "@costgrid/db";

function money(value: Nanodollars): string {
  const dollars = toUsdNumber(value);
  // Sub-cent totals are normal early on; showing "$0.00" would look like a bug.
  return dollars > 0 && dollars < 0.01 ? `$${toUsdString(value, 6)}` : `$${dollars.toFixed(2)}`;
}

function bar(fraction: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return "█".repeat(filled) + "·".repeat(width - filled);
}

function table(rows: { label: string; cost: Nanodollars; calls: number }[], max: Nanodollars): string {
  if (rows.length === 0) return "  (nothing recorded)";
  const width = Math.max(...rows.map((r) => r.label.length));

  return rows
    .map((row) => {
      const fraction = max > 0n ? Number(row.cost) / Number(max) : 0;
      return (
        `  ${row.label.padEnd(width)}  ${bar(fraction)}  ` +
        `${money(row.cost).padStart(10)}  ${String(row.calls).padStart(6)} calls`
      );
    })
    .join("\n");
}

/**
 * Render the spend report.
 *
 * Deliberately blunt about what is not known: unpriced calls and blocked calls
 * are called out rather than folded into a total, because a cost figure that
 * quietly omits traffic is worse than no figure.
 */
export function formatReport(
  analytics: Analytics,
  tenantId: string,
  range: TimeRange,
  days: number,
): string {
  const summary = analytics.summary(tenantId, range);
  const byModel = analytics.spendByModel(tenantId, range);
  const byAgent = analytics.spendByAgent(tenantId, range);
  const byDept = analytics.spendByDepartment(tenantId, range);
  const share = analytics.substitutionShare(tenantId, range);
  const violations = analytics.recentViolations(tenantId, 8);

  const out: string[] = [];
  const rule = "─".repeat(72);

  out.push(rule);
  out.push(`  COSTGRID — last ${days} day${days === 1 ? "" : "s"}`);
  out.push(rule);

  if (summary.calls === 0) {
    out.push("");
    out.push("  No calls recorded yet. Point a client at the gateway and make a request.");
    out.push("");
    return out.join("\n");
  }

  const dailyRate = toUsdNumber(summary.totalCost) / days;
  out.push("");
  out.push(`  Total spend        ${money(summary.totalCost)}`);
  out.push(`  Run-rate           $${(dailyRate * 30).toFixed(2)} / 30 days`);
  out.push(`  Calls              ${summary.calls}`);
  out.push(
    `  Cache hit ratio    ${(summary.cacheHitRatio * 100).toFixed(1)}%  ` +
      `(${summary.cacheReadTokens.toLocaleString("en-US")} tokens served from cache)`,
  );
  out.push(`  Substitution share ${(share * 100).toFixed(1)}% of tokens off the frontier tier`);

  if (summary.blockedCalls > 0) out.push(`  Blocked            ${summary.blockedCalls} by policy`);
  if (summary.erroredCalls > 0) out.push(`  Errored            ${summary.erroredCalls}`);
  if (summary.unpricedCalls > 0) {
    out.push(
      `  UNPRICED           ${summary.unpricedCalls} call(s) used a model absent from the price`,
    );
    out.push("                     catalog — their cost reads as zero and the total is understated.");
  }

  const maxModel = byModel.reduce((m, r) => (r.cost > m ? r.cost : m), 0n);
  out.push("");
  out.push("  By model");
  out.push(table(byModel.map((r) => ({ label: r.key, ...r })), maxModel));

  if (byAgent.length > 0) {
    const maxAgent = byAgent.reduce((m, r) => (r.cost > m ? r.cost : m), 0n);
    out.push("");
    out.push("  By agent");
    out.push(table(byAgent.map((r) => ({ label: r.key, ...r })), maxAgent));
  }

  // Only worth showing once someone has actually labelled their traffic.
  if (byDept.length > 1 || (byDept[0] && byDept[0].key !== "Unassigned")) {
    const maxDept = byDept.reduce((m, r) => (r.cost > m ? r.cost : m), 0n);
    out.push("");
    out.push("  By department");
    out.push(table(byDept.map((r) => ({ label: r.key, ...r })), maxDept));
  }

  // The routing model, now anchored to a measured share rather than an assumed one.
  const routing = analyzeRouting(share);
  out.push("");
  out.push("  Routing");
  out.push(`    observed share   ${(share * 100).toFixed(1)}%`);
  out.push(`    modelled optimum ${(routing.optimalShare * 100).toFixed(1)}%`);
  if (routing.savingFraction > 0.01) {
    const projected = toUsdNumber(summary.totalCost) * routing.savingFraction;
    out.push(
      `    headroom         ${(routing.savingFraction * 100).toFixed(0)}% ` +
        `(~$${projected.toFixed(2)} over this window, on model assumptions)`,
    );
  } else {
    out.push("    headroom         at or past the modelled optimum");
  }

  if (violations.length > 0) {
    out.push("");
    out.push("  Recent policy events");
    for (const v of violations) {
      const when = new Date(v.occurredAt).toISOString().slice(0, 16).replace("T", " ");
      out.push(`    ${when}  ${v.action.padEnd(7)} ${v.agentId ?? "?"} — ${v.reason}`);
    }
  }

  out.push("");
  return out.join("\n");
}
