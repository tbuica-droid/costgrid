import {
  computeLcso,
  computeLcsoAggregate,
  type DetectedTask,
  detectOutcomes,
  type LcsoResult,
  matchesEscalation,
  type Nanodollars,
  type PurposePreset,
  presetFor,
  type RunSummary,
  runStatusOf,
  type TaskSource,
} from "@costgrid/core";
import { AgentsRepository } from "./agents.js";
import type { Db } from "./database.js";
import { type JobCount, JobInputs, type PersonCost, personBaseline } from "./job-inputs.js";

/**
 * Whether each agent's jobs got done, from the calls the proxy recorded.
 *
 * Runs are summarised from `calls` (who, when, what it cost, how its last call
 * ended, which job it belongs to), sub-agent runs folded into the run that
 * started them, hand-off tools looked up by name, and reported outcomes
 * attached. Then the detector (`@costgrid/core` outcome-detect) decides each
 * job and the LCSO engine prices it, per agent, under the agent's preset.
 *
 * Only proxied traffic has runs. Agents known only from provider usage
 * reports are listed apart, as having no outcome data.
 */

const DAY_MS = 86_400_000;

export interface AgentOutcomes {
  readonly agentId: string;
  readonly name: string | null;
  readonly preset: PurposePreset;
  /** False when the agent has no purpose and is measured as "other". */
  readonly purposeSet: boolean;
  /** The agent's preset version has no detection rules: offer the newer version. */
  readonly needsUpgrade: boolean;
  /** Undefined when detection did not run (needsUpgrade). */
  readonly result?: LcsoResult;
  /** The jobs counted in the period. */
  readonly tasks: readonly DetectedTask[];
  readonly totalCost: Nanodollars;
  readonly escalationTools: readonly string[];
  readonly sharedOpenings: number;
  /** The owner's estimate of the same job done by a person. */
  readonly person?: PersonCost;
}

/**
 * An agent known only from provider usage reports. With a job count the
 * owner entered, its latest such month is priced from totals alone.
 */
export interface ProviderOnlyOutcomes {
  readonly id: string;
  readonly name: string | null;
  readonly person?: PersonCost;
  /** Newest first. */
  readonly counts: readonly JobCount[];
  /** For `counts[0]`, when there is one. */
  readonly latest?: { readonly month: string; readonly cost: Nanodollars; readonly result: LcsoResult };
}

export interface OutcomesReport {
  readonly agents: AgentOutcomes[];
  /** Agents with provider usage but no proxied runs in the period. */
  readonly noOutcomeData: ProviderOnlyOutcomes[];
  /** The longest maturation plus re-run window any agent needs, so the caller can compare it with retention. */
  readonly longestWindowMs: number;
}

interface RunRow {
  runId: string;
  agentId: string;
  parentRunId: string | null;
  startedAt: number;
  endedAt: number;
  cost: bigint;
  firstKey: string | null;
  firstSource: "header" | "fingerprint" | null;
  headerKey: string | null;
  turns: number | null;
  lastOutcome: string;
  lastStatus: number | null;
  lastStop: string | null;
}

/** The furthest back a job in the period can have started: the longest maturation plus re-run window. */
const LOOKBACK_MS = 16 * DAY_MS;

export class RunOutcomes {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  forTenant(tenantId: string, range: { from: number; to: number }, asOf: number): OutcomesReport {
    const runs = this.#runs(tenantId, range.from - LOOKBACK_MS, range.to);
    const escalations = this.#escalations(tenantId, range.from - LOOKBACK_MS, range.to);
    const reported = this.#reported(tenantId);
    const inputs = new JobInputs(this.#db);
    const persons = inputs.personCosts(tenantId);
    const agents = new Map(
      (
        this.#db
          .prepare("SELECT id, name, purpose_id AS purposeId, purpose_version AS purposeVersion FROM agents WHERE tenant_id = ?")
          .all(tenantId) as { id: string; name: string | null; purposeId: string | null; purposeVersion: string | null }[]
      ).map((a) => [a.id, a]),
    );

    const byAgent = new Map<string, RunSummary[]>();
    const toolsByAgent = new Map<string, Set<string>>();
    for (const root of foldSubAgents(runs)) {
      const own = root.members;
      const tools = own.flatMap((r) => escalations.get(r.runId) ?? []);
      if (tools.length > 0) {
        const set = toolsByAgent.get(root.agentId) ?? new Set<string>();
        for (const t of tools) set.add(t);
        toolsByAgent.set(root.agentId, set);
      }
      const latest = own.reduce((a, b) => (b.endedAt >= a.endedAt ? b : a));
      const reports = own.map((r) => reported.get(r.runId)).filter((r) => r !== undefined);
      const report = reports.length === 0 ? undefined : reports.reduce((a, b) => (b.at >= a.at ? b : a));
      const key = root.headerKey ?? root.firstKey;
      const source: TaskSource = root.headerKey !== null ? "header" : (root.firstSource ?? "none");
      const summary: RunSummary = {
        runId: root.runId,
        ...(key !== null && source !== "none" ? { taskKey: key } : {}),
        taskSource: key === null ? "none" : source,
        ...(root.turns !== null ? { turns: root.turns } : {}),
        startedAt: Math.min(...own.map((r) => r.startedAt)),
        endedAt: Math.max(...own.map((r) => r.endedAt)),
        cost: own.reduce((sum, r) => sum + r.cost, 0n),
        finalStatus: runStatusOf(latest.lastOutcome, latest.lastStatus, latest.lastStop),
        escalated: tools.length > 0,
        ...(report !== undefined ? { reported: report } : {}),
      };
      byAgent.set(root.agentId, [...(byAgent.get(root.agentId) ?? []), summary]);
    }

    const results: AgentOutcomes[] = [];
    let longestWindowMs = 0;
    for (const [agentId, agentRuns] of byAgent) {
      if (!agentRuns.some((r) => r.endedAt >= range.from && r.startedAt < range.to)) continue;
      const agent = agents.get(agentId);
      const purposeSet = agent?.purposeId != null;
      const preset =
        (purposeSet ? presetFor(agent!.purposeId!, agent!.purposeVersion ?? undefined) : undefined) ?? presetFor("other")!;
      const needsUpgrade = preset.reRunWindowMs === undefined;
      const person = persons.get(agentId);
      const base = {
        agentId,
        name: agent?.name ?? null,
        preset,
        purposeSet,
        needsUpgrade,
        escalationTools: [...(toolsByAgent.get(agentId) ?? [])].sort(),
        ...(person !== undefined ? { person } : {}),
      };
      if (needsUpgrade) {
        results.push({ ...base, tasks: [], totalCost: 0n, sharedOpenings: 0 });
        continue;
      }
      longestWindowMs = Math.max(longestWindowMs, preset.maturationWindowMs + preset.reRunWindowMs!);
      const detection = detectOutcomes(
        agentRuns,
        { reRunWindowMs: preset.reRunWindowMs!, maturationWindowMs: preset.maturationWindowMs },
        asOf,
      );
      // A job belongs to the period it resolved in; its earlier runs come with it.
      const tasks = detection.tasks.filter((t) => t.task.resolvedAt! >= range.from && t.task.resolvedAt! < range.to);
      const result = computeLcso({
        workflowId: agentId,
        period: range,
        successDefinition: { id: preset.id, version: preset.version, maturationWindowMs: preset.maturationWindowMs },
        asOf,
        tasks: tasks.map((t) => t.task),
        ...(person !== undefined ? { humanBaseline: personBaseline(person) } : {}),
      });
      results.push({
        ...base,
        result,
        tasks,
        totalCost: tasks.reduce((sum, t) => sum + t.task.runs.reduce((s, r) => s + r.cost, 0n), 0n),
        sharedOpenings: tasks.filter((t) => t.signals.includes("shared-opening")).length,
      });
    }
    results.sort((a, b) => (a.totalCost === b.totalCost ? a.agentId.localeCompare(b.agentId) : a.totalCost > b.totalCost ? -1 : 1));

    const proxied = new Set(results.map((r) => r.agentId));
    const counts = inputs.jobCounts(tenantId);
    const views = new Map<string, ReturnType<AgentsRepository["view"]>>();
    const noOutcomeData = (
      this.#db
        .prepare(
          `SELECT a.id, a.name FROM agents a
           WHERE a.tenant_id = ? AND EXISTS (
             SELECT 1 FROM usage_sources s WHERE s.tenant_id = a.tenant_id AND s.agent_id = a.id)
           ORDER BY a.name, a.id`,
        )
        .all(tenantId) as { id: string; name: string | null }[]
    )
      .filter((a) => !proxied.has(a.id))
      .map((a) => this.#providerOnly(tenantId, a, persons.get(a.id), counts.get(a.id) ?? [], views));

    return { agents: results, noOutcomeData, longestWindowMs };
  }

  /** Totals-only figures for the newest month the owner counted: that month's provider-reported cost over the count. */
  #providerOnly(
    tenantId: string,
    agent: { id: string; name: string | null },
    person: PersonCost | undefined,
    counts: JobCount[],
    views: Map<string, ReturnType<AgentsRepository["view"]>>,
  ): ProviderOnlyOutcomes {
    const base = { ...agent, counts, ...(person !== undefined ? { person } : {}) };
    const latest = counts[0];
    if (latest === undefined) return base;
    const [year, month] = latest.month.split("-").map(Number) as [number, number];
    const from = Date.UTC(year, month - 1, 1);
    const to = Date.UTC(year, month, 1);
    const days = { from: latest.month + "-01", to: new Date(to - DAY_MS).toISOString().slice(0, 10) };
    // One view per month, shared by every agent counted in it.
    let view = views.get(latest.month);
    if (view === undefined) {
      view = new AgentsRepository(this.#db).view(tenantId, days);
      views.set(latest.month, view);
    }
    const cost = view.agents.find((a) => a.id === agent.id)?.imported.costNano ?? 0n;
    const result = computeLcsoAggregate({
      workflowId: agent.id,
      period: { from, to },
      successDefinition: { id: "owner-count", version: "1", maturationWindowMs: 0 },
      modelCost: cost,
      successCount: latest.finished,
      ...(latest.notFinished !== null ? { failureCount: latest.notFinished, abandonedCount: 0, unknownCount: 0 } : {}),
      ...(person !== undefined ? { humanBaseline: personBaseline(person) } : {}),
    });
    return { ...base, latest: { month: latest.month, cost, result } };
  }

  /** One row per run: first call's job identity, last call's ending, totals. */
  #runs(tenantId: string, from: number, to: number): RunRow[] {
    return this.#db
      .prepare(
        `WITH ranked AS (
           SELECT run_id, agent_id, parent_run_id, started_at, duration_ms, cost_total, outcome, status_code,
                  stop_reason, task_key, task_source, turns,
                  ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY started_at, id) AS first_n,
                  ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY started_at DESC, id DESC) AS last_n
           FROM calls WHERE tenant_id = ? AND started_at >= ? AND started_at < ?
         )
         SELECT run_id AS runId, MIN(agent_id) AS agentId, MAX(parent_run_id) AS parentRunId,
                MIN(started_at) AS startedAt, MAX(started_at + duration_ms) AS endedAt,
                COALESCE(SUM(cost_total), 0) AS cost,
                MAX(CASE WHEN first_n = 1 THEN task_key END) AS firstKey,
                MAX(CASE WHEN first_n = 1 THEN task_source END) AS firstSource,
                MAX(CASE WHEN task_source = 'header' THEN task_key END) AS headerKey,
                MAX(CASE WHEN first_n = 1 THEN turns END) AS turns,
                MAX(CASE WHEN last_n = 1 THEN outcome END) AS lastOutcome,
                MAX(CASE WHEN last_n = 1 THEN status_code END) AS lastStatus,
                MAX(CASE WHEN last_n = 1 THEN stop_reason END) AS lastStop
         FROM ranked GROUP BY run_id`,
      )
      .safeIntegers(true)
      .all(tenantId, from, to)
      .map((row) => {
        const r = row as Record<string, unknown>;
        const num = (v: unknown): number | null => (v === null ? null : Number(v));
        return {
          runId: r["runId"] as string,
          agentId: r["agentId"] as string,
          parentRunId: r["parentRunId"] as string | null,
          startedAt: Number(r["startedAt"]),
          endedAt: Number(r["endedAt"]),
          cost: r["cost"] as bigint,
          firstKey: r["firstKey"] as string | null,
          firstSource: r["firstSource"] as RunRow["firstSource"],
          headerKey: r["headerKey"] as string | null,
          turns: num(r["turns"]),
          lastOutcome: r["lastOutcome"] as string,
          lastStatus: num(r["lastStatus"]),
          lastStop: r["lastStop"] as string | null,
        };
      });
  }

  /** Hand-off tool names used, by run. */
  #escalations(tenantId: string, from: number, to: number): Map<string, string[]> {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT run_id AS runId, tool_name AS tool FROM tool_invocations
         WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ?`,
      )
      .all(tenantId, from, to) as { runId: string; tool: string }[];
    const byRun = new Map<string, string[]>();
    for (const { runId, tool } of rows) {
      if (matchesEscalation(tool)) byRun.set(runId, [...(byRun.get(runId) ?? []), tool]);
    }
    return byRun;
  }

  #reported(tenantId: string): Map<string, { succeeded: boolean; at: number }> {
    const rows = this.#db
      .prepare("SELECT run_id AS runId, succeeded, reported_at AS at FROM outcomes WHERE tenant_id = ?")
      .all(tenantId) as { runId: string; succeeded: number; at: number }[];
    return new Map(rows.map((r) => [r.runId, { succeeded: r.succeeded === 1, at: r.at }]));
  }
}

/** Each run that no other run in the set started, with every run it started folded in. */
function foldSubAgents(runs: RunRow[]): (RunRow & { members: RunRow[] })[] {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const rootOf = (run: RunRow): RunRow => {
    let current = run;
    const seen = new Set<string>([run.runId]);
    while (current.parentRunId !== null && byId.has(current.parentRunId) && !seen.has(current.parentRunId)) {
      current = byId.get(current.parentRunId)!;
      seen.add(current.runId);
    }
    return current;
  };
  const roots = new Map<string, RunRow & { members: RunRow[] }>();
  for (const run of runs) {
    const root = rootOf(run);
    const entry = roots.get(root.runId) ?? { ...root, members: [] };
    entry.members.push(run);
    roots.set(root.runId, entry);
  }
  return [...roots.values()];
}
