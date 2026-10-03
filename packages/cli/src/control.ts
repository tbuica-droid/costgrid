import {
  EFFORT_LEVELS,
  isReasoningEffort,
  type Nanodollars,
  type PolicyRule,
  type PolicyScope,
  toUsdString,
} from "@costgrid/core";
import {
  type CostGridRepository,
  type Db,
  Insights,
  MeasuredSavings,
  RuleRegister,
  type TimeRange,
} from "@costgrid/db";
import { recordCli } from "./security.js";

/**
 * The command-line half of the Limits and Results screens: stopping an
 * agent, capping reasoning, and the research-backed sections of the report.
 *
 * Its own file because `main.ts` is long enough already, and because each of
 * these is the same engine the console drives, so the two cannot disagree.
 */

const money = (value: Nanodollars): string => `$${toUsdString(value, 4)}`;

function scopeOf(raw: string): PolicyScope | undefined {
  if (raw === "tenant" || raw === "everything") return { kind: "tenant" };
  if (raw.startsWith("dept:")) return { kind: "department", department: raw.slice(5) };
  if (raw.startsWith("agent:")) return { kind: "agent", agentId: raw.slice(6) };
  // A bare name is the common case: `costgrid agent stop support-bot`.
  return raw === "" ? undefined : { kind: "agent", agentId: raw };
}

/**
 * `costgrid agent stop <who> [--reason "..."]` and `costgrid agent resume <who>`.
 *
 * Returns the lines to print, or throws with a message for the user.
 */
export function agentCommand(
  db: Db,
  repository: CostGridRepository,
  tenantId: string,
  argv: readonly string[],
  reason: string | undefined,
): string[] {
  const sub = argv[1];
  const scope = scopeOf(argv[2] ?? "");
  if ((sub !== "stop" && sub !== "resume") || scope === undefined) {
    throw new Error('usage: costgrid agent stop|resume <agent | dept:<team> | tenant> [--reason "..."]');
  }
  const same = (p: { scope: PolicyScope }) => JSON.stringify(p.scope) === JSON.stringify(scope);
  const live = repository.listPolicies(tenantId).filter((p) => p.enabled && p.rule.kind === "stop" && same(p));

  if (sub === "resume") {
    if (live.length === 0) return ["Nothing to resume: that is not stopped."];
    for (const p of live) {
      repository.setPolicyEnabled(p.id, false);
      recordCli(db, tenantId, "policy.disabled", p.id, { name: p.name, kind: "stop" });
    }
    return ["Resumed. The stop stays in the rule register and the audit log."];
  }

  if (live.length > 0) return [`Already stopped (${live[0]!.id}).`];
  const name = `Stop ${scope.kind === "tenant" ? "everything" : scope.kind === "department" ? `team ${scope.department}` : scope.agentId}`;
  const id = repository.createPolicy(tenantId, {
    name,
    scope,
    rule: { kind: "stop" },
    action: "block",
    enabled: true,
    ...(reason !== undefined ? { reason } : {}),
  });
  recordCli(db, tenantId, "policy.created", id, { name, kind: "stop", action: "block" });
  return [
    `Stopped. ${id}`,
    "Every call from it is now refused before it reaches the provider, so nothing is billed.",
    "Other agents are unaffected. Undo with: costgrid agent resume " + (argv[2] ?? ""),
  ];
}

/** `costgrid policy reasoning <scope> [--effort LEVEL] [--budget TOKENS]`. */
export function reasoningRule(effort: string | undefined, budget: string | undefined): PolicyRule {
  const rule: { kind: "max-reasoning"; effort?: (typeof EFFORT_LEVELS)[number]; budgetTokens?: number } = {
    kind: "max-reasoning",
  };
  if (effort !== undefined) {
    if (!isReasoningEffort(effort)) throw new Error(`--effort must be one of ${EFFORT_LEVELS.join(", ")}`);
    rule.effort = effort;
  }
  if (budget !== undefined) {
    const tokens = Number(budget);
    if (!Number.isInteger(tokens) || tokens < 1) throw new Error("--budget must be a whole number of tokens");
    rule.budgetTokens = tokens;
  }
  if (rule.effort === undefined && rule.budgetTokens === undefined) {
    throw new Error("policy reasoning needs --effort, --budget, or both");
  }
  return rule;
}

/** The report sections that answer the research's questions rather than "what did it cost". */
export function formatResearchSections(
  db: Db,
  repository: CostGridRepository,
  tenantId: string,
  range: TimeRange,
): string {
  const out: string[] = [];
  const insights = new Insights(db);

  const spread = insights.runSpread(tenantId, range).slice(0, 8);
  if (spread.length > 0) {
    out.push("", "  What a run costs (declared runs only)");
    out.push("    agent                    runs    typical       bad (p95)     worst");
    for (const s of spread) {
      out.push(
        `    ${s.agentId.slice(0, 24).padEnd(24)} ${String(s.runs).padStart(5)}   ` +
          `${money(s.median).padEnd(12)}  ${money(s.p95).padEnd(12)}  ${money(s.max)}`,
      );
    }
    out.push("    The same task can cost many times more on one run than another. A per-run");
    out.push("    limit a little above the bad column stops runaways without touching normal work.");
  }

  const reasoning = insights.reasoning(tenantId, range);
  const reported = reasoning.byModel.filter((m) => m.reportedCalls > 0);
  if (reported.length > 0) {
    out.push("", "  Reasoning (models that report it)");
    for (const m of reported) {
      const share = m.cost > 0n ? (Number(m.reasoningCost) / Number(m.cost)) * 100 : 0;
      out.push(`    ${m.model.padEnd(24)} ${money(m.reasoningCost)} of ${money(m.cost)} (${share.toFixed(0)}%)`);
    }
  }
  for (const o of reasoning.overthinking) {
    out.push(`    ${o.agentId}: ${o.calls} short answers after long reasoning (${money(o.reasoningCost)})`);
  }

  const entries = new RuleRegister(db, repository).entries(tenantId, range);
  const measured = new MeasuredSavings(db).forPolicies(tenantId, entries);
  if (measured.length > 0) {
    out.push("", "  Did switching models save money? (measured, before and after)");
    for (const m of measured) {
      const change = m.changePerRun ?? m.changePerCall;
      out.push(
        `    ${m.fromModel} -> ${m.toModel}: ${m.verdict}` +
          (change === null ? "" : ` (${change > 0 ? "+" : ""}${(change * 100).toFixed(0)}% ${m.changePerRun !== null ? "per run" : "per call"})`),
      );
    }
    out.push("    Before-and-after on your own traffic, not a controlled experiment.");
  }

  const unowned = entries.filter((e) => e.enabled && e.owner === null && e.rule.kind !== "stop");
  if (unowned.length > 0) {
    out.push("", `  ${unowned.length} rule(s) in force with no owner recorded. Unowned rules drift out of date.`);
  }
  return out.join("\n");
}
