import type { Nanodollars } from "@costgrid/core";
import type { Db } from "./database.js";
import type { TimeRange } from "./analytics.js";

/**
 * Noticing when a fleet starts behaving differently.
 *
 * Everything else in this product governs resources: money, steps, depth, a
 * list of permitted tools written in advance by someone who already knew what
 * to worry about. This is the first thing that governs *behaviour*, and it
 * works by comparing what a fleet did recently against what it has always
 * done.
 *
 * The distinction it can make, and the only one it claims, is **usual versus
 * unusual**. Not safe versus dangerous, and not right versus wrong. An agent
 * calling a tool for the first time is far more often a deploy than an
 * incident, and a detector that treats those the same gets muted within a
 * week. Every signal is therefore a fact about the shape of the traffic, with
 * the interpretation left to a person.
 *
 * No content is read. Everything here is names, counts and graph structure
 * that CostGrid already stores.
 */

export type DriftKind =
  /**
   * A tool the model asked to run that was never offered to it.
   *
   * The one signal here that is not merely unusual. A request carries the list
   * of tools the model may call; an invocation outside that list is the model
   * producing the name itself. That is a hallucination, observed structurally
   * rather than judged, and it is the only kind this product can honestly
   * claim to detect.
   */
  | "invented-tool"
  | "new-tool"
  | "new-model"
  | "new-delegation"
  | "new-agent"
  | "depth-spike"
  | "steps-spike";

export interface DriftSignal {
  readonly kind: DriftKind;
  readonly agentId: string;
  /** The tool, model or agent this is about, where there is one. */
  readonly subject?: string;
  readonly headline: string;
  readonly evidence: string;
  readonly occurrences: number;
  readonly firstSeenAt: number;
  /** Money involved, for ordering. Zero where the signal costs nothing. */
  readonly spend: Nanodollars;
}

export interface DriftReport {
  readonly baseline: TimeRange;
  readonly recent: TimeRange;
  readonly baselineCalls: number;
  /** False when there is not enough history for "never before" to mean anything. */
  readonly established: boolean;
  readonly signals: readonly DriftSignal[];
}

/**
 * Calls a fleet must have made before "it has never done this" means anything.
 *
 * Without a floor, a customer's first week reports everything their software
 * does as new behaviour, which is both true and useless.
 */
const MIN_BASELINE_CALLS = 500;

/** Beyond the deepest or longest the baseline ever saw, by this multiple. */
const SPIKE_MULTIPLE = 2;

type Pair = { agentId: string; thing: string };

/** agent -> set of things it has done before. Avoids joining keys into strings. */
function index(rows: readonly Pair[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = m.get(r.agentId);
    if (!set) m.set(r.agentId, (set = new Set()));
    set.add(r.thing);
  }
  return m;
}

export class Drift {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Compare a recent window against everything before it.
   *
   * Two windows rather than a stored baseline, so the baseline maintains
   * itself and cannot go stale while nobody is looking. The cost is that a
   * behaviour which appeared a month ago is no longer new, which is correct:
   * by then it is simply how the fleet works.
   */
  report(tenantId: string, recent: TimeRange, baselineDays = 30): DriftReport {
    const baseline: TimeRange = {
      from: recent.from - baselineDays * 86_400_000,
      to: recent.from,
    };

    const baselineCalls = (
      this.#db
        .prepare(
          `SELECT COUNT(*) AS n FROM calls
           WHERE tenant_id = ? AND started_at >= ? AND started_at < ?`,
        )
        .get(tenantId, baseline.from, baseline.to) as { n: number }
    ).n;

    /*
     * Invented tools are reported with or without a baseline. A model calling
     * a tool nobody gave it is wrong on the first day as much as the
     * hundredth, and needs no history to establish that.
     */
    const signals: DriftSignal[] = [...this.#inventedTools(tenantId, recent)];
    const established = baselineCalls >= MIN_BASELINE_CALLS;

    if (established) {
      const days = Math.round((baseline.to - baseline.from) / 86_400_000);
      signals.push(
        ...this.#firstTimeTools(tenantId, baseline, recent, days),
        ...this.#firstTimeModels(tenantId, baseline, recent, days),
        ...this.#firstTimeDelegations(tenantId, baseline, recent, days),
        ...this.#newAgents(tenantId, baseline, recent),
        ...this.#spikes(tenantId, baseline, recent),
      );
    }

    /*
     * A tool the model invented is also, trivially, a tool it has never used
     * before. Reporting both says the same thing twice and buries the half
     * that matters, so the weaker signal is dropped.
     */
    const invented = new Set(
      signals
        .filter((x) => x.kind === "invented-tool")
        .map((x) => `${x.agentId}/${x.subject ?? ""}`),
    );
    const deduped = signals.filter(
      (x) => x.kind !== "new-tool" || !invented.has(`${x.agentId}/${x.subject ?? ""}`),
    );

    // An invented tool outranks everything: it is the only signal that is
    // wrong rather than merely new.
    const rank = (s: DriftSignal) => (s.kind === "invented-tool" ? 0 : 1);
    deduped.sort((a, b) => rank(a) - rank(b) || b.occurrences - a.occurrences);

    return { baseline, recent, baselineCalls, established, signals: deduped };
  }

  // -------------------------------------------------------- invented tools

  #inventedTools(tenantId: string, recent: TimeRange): DriftSignal[] {
    const rows = this.#db
      .prepare(
        `SELECT i.agent_id AS agentId, i.tool_name AS toolName,
                COUNT(*) AS n, MIN(i.occurred_at) AS firstSeen
         FROM tool_invocations i
         WHERE i.tenant_id = ? AND i.occurred_at >= ? AND i.occurred_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM tool_grants g
             WHERE g.tenant_id = i.tenant_id
               AND g.agent_id = i.agent_id
               AND g.tool_name = i.tool_name
           )
         GROUP BY i.agent_id, i.tool_name
         ORDER BY n DESC`,
      )
      .all(tenantId, recent.from, recent.to) as {
      agentId: string;
      toolName: string;
      n: number;
      firstSeen: number;
    }[];

    return rows.map((r) => ({
      kind: "invented-tool" as const,
      agentId: r.agentId,
      subject: r.toolName,
      headline: `${r.agentId} asked to run ${r.toolName}, which it was never given`,
      evidence:
        `${r.n} time(s) in this window. The request never offered ${r.toolName} to the model, ` +
        "so the model produced that name itself. This is the one signal here that is not " +
        "merely unusual: it is the model inventing a capability. A tool boundary stops it " +
        "reaching your code.",
      occurrences: r.n,
      firstSeenAt: r.firstSeen,
      spend: 0n,
    }));
  }

  // ------------------------------------------------------------ first time

  #firstTimeTools(t: string, b: TimeRange, r: TimeRange, days: number): DriftSignal[] {
    const known = index(
      this.#db
        .prepare(
          `SELECT DISTINCT agent_id AS agentId, tool_name AS thing FROM tool_invocations
           WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ?`,
        )
        .all(t, b.from, b.to) as Pair[],
    );

    const rows = this.#db
      .prepare(
        `SELECT agent_id AS agentId, tool_name AS thing, COUNT(*) AS n,
                MIN(occurred_at) AS firstSeen
         FROM tool_invocations
         WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ?
         GROUP BY agent_id, tool_name`,
      )
      .all(t, r.from, r.to) as (Pair & { n: number; firstSeen: number })[];

    return rows
      .filter((x) => !known.get(x.agentId)?.has(x.thing))
      .map((x) => ({
        kind: "new-tool" as const,
        agentId: x.agentId,
        subject: x.thing,
        headline: `${x.agentId} started using the tool ${x.thing}`,
        evidence: this.#newnessNote(x.n, days),
        occurrences: x.n,
        firstSeenAt: x.firstSeen,
        spend: 0n,
      }));
  }

  #firstTimeModels(t: string, b: TimeRange, r: TimeRange, days: number): DriftSignal[] {
    const known = index(
      this.#db
        .prepare(
          `SELECT DISTINCT agent_id AS agentId, model AS thing FROM calls
           WHERE tenant_id = ? AND started_at >= ? AND started_at < ?`,
        )
        .all(t, b.from, b.to) as Pair[],
    );

    const rows = this.#db
      .prepare(
        `SELECT agent_id AS agentId, model AS thing, COUNT(*) AS n,
                MIN(started_at) AS firstSeen, COALESCE(SUM(cost_total), 0) AS spend
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ? AND started_at < ?
         GROUP BY agent_id, model`,
      )
      .safeIntegers(true)
      .all(t, r.from, r.to) as unknown as (Pair & { n: bigint; firstSeen: bigint; spend: bigint })[];

    return rows
      .filter((x) => !known.get(x.agentId)?.has(x.thing))
      .map((x) => ({
        kind: "new-model" as const,
        agentId: x.agentId,
        subject: x.thing,
        headline: `${x.agentId} started calling ${x.thing}`,
        evidence: this.#newnessNote(Number(x.n), days),
        occurrences: Number(x.n),
        firstSeenAt: Number(x.firstSeen),
        spend: x.spend,
      }));
  }

  #firstTimeDelegations(t: string, b: TimeRange, r: TimeRange, days: number): DriftSignal[] {
    // The parent is collapsed to one row per run before joining. Joining call
    // rows directly produces a cartesian product, which once reported 36
    // delegations where there was one.
    const sql = (where: string) => `
      SELECT parent.agent_id AS agentId, child.agent_id AS thing,
             COUNT(*) AS n, MIN(child.started_at) AS firstSeen
      FROM calls child
      JOIN (SELECT tenant_id, run_id, MIN(agent_id) AS agent_id
            FROM calls GROUP BY tenant_id, run_id) parent
        ON parent.tenant_id = child.tenant_id AND parent.run_id = child.parent_run_id
      WHERE child.tenant_id = ? AND child.parent_run_id IS NOT NULL AND ${where}
      GROUP BY parent.agent_id, child.agent_id`;

    const known = index(
      this.#db
        .prepare(sql("child.started_at >= ? AND child.started_at < ?"))
        .all(t, b.from, b.to) as Pair[],
    );

    const rows = this.#db
      .prepare(sql("child.started_at >= ? AND child.started_at < ?"))
      .all(t, r.from, r.to) as (Pair & { n: number; firstSeen: number })[];

    return rows
      .filter((x) => !known.get(x.agentId)?.has(x.thing))
      .map((x) => ({
        kind: "new-delegation" as const,
        agentId: x.agentId,
        subject: x.thing,
        headline: `${x.agentId} started handing work to ${x.thing}`,
        evidence: this.#newnessNote(x.n, days),
        occurrences: x.n,
        firstSeenAt: x.firstSeen,
        spend: 0n,
      }));
  }

  #newAgents(t: string, b: TimeRange, r: TimeRange): DriftSignal[] {
    const known = new Set(
      (
        this.#db
          .prepare(
            `SELECT DISTINCT agent_id AS a FROM calls
             WHERE tenant_id = ? AND started_at >= ? AND started_at < ?`,
          )
          .all(t, b.from, b.to) as { a: string }[]
      ).map((x) => x.a),
    );

    const rows = this.#db
      .prepare(
        `SELECT agent_id AS agentId, COUNT(*) AS n, MIN(started_at) AS firstSeen,
                COALESCE(SUM(cost_total), 0) AS spend
         FROM calls
         WHERE tenant_id = ? AND started_at >= ? AND started_at < ?
         GROUP BY agent_id`,
      )
      .safeIntegers(true)
      .all(t, r.from, r.to) as unknown as {
      agentId: string;
      n: bigint;
      firstSeen: bigint;
      spend: bigint;
    }[];

    return rows
      .filter((x) => !known.has(x.agentId))
      .map((x) => ({
        kind: "new-agent" as const,
        agentId: x.agentId,
        headline: `${x.agentId} appeared, and has never run before`,
        evidence:
          `${x.n} call(s) in this window and none before it. If you were not expecting a new ` +
          "service to start calling AI, this is the line to look at.",
        occurrences: Number(x.n),
        firstSeenAt: Number(x.firstSeen),
        spend: x.spend,
      }));
  }

  #spikes(t: string, b: TimeRange, r: TimeRange): DriftSignal[] {
    const perRun = (where: string) => `
      SELECT agent_id AS agentId, run_id AS runId, MAX(run_depth) AS depth,
             COUNT(*) AS steps, MIN(started_at) AS firstSeen
      FROM calls
      WHERE tenant_id = ? AND run_declared = 1 AND ${where}
      GROUP BY run_id`;

    const priorRuns = this.#db
      .prepare(perRun("started_at >= ? AND started_at < ?"))
      .all(t, b.from, b.to) as { agentId: string; depth: number; steps: number }[];
    if (priorRuns.length === 0) return [];

    const was = new Map<string, { depth: number; steps: number }>();
    for (const run of priorRuns) {
      const seen = was.get(run.agentId) ?? { depth: 0, steps: 0 };
      was.set(run.agentId, {
        depth: Math.max(seen.depth, run.depth),
        steps: Math.max(seen.steps, run.steps),
      });
    }

    const rows = this.#db
      .prepare(perRun("started_at >= ? AND started_at < ?"))
      .all(t, r.from, r.to) as {
      agentId: string;
      runId: string;
      depth: number;
      steps: number;
      firstSeen: number;
    }[];

    const out: DriftSignal[] = [];
    const reported = new Set<string>();

    for (const run of rows) {
      const before = was.get(run.agentId);
      if (!before) continue;

      // The +5 and +1 floors stop a quiet agent tripping this the first time
      // it does anything at all.
      if (
        run.steps > Math.max(before.steps * SPIKE_MULTIPLE, before.steps + 5) &&
        !reported.has(`steps:${run.agentId}`)
      ) {
        reported.add(`steps:${run.agentId}`);
        out.push({
          kind: "steps-spike",
          agentId: run.agentId,
          headline: `${run.agentId} ran ${run.steps} steps, far past its previous longest`,
          evidence:
            `Run ${run.runId} took ${run.steps} calls. The longest this agent had ever run ` +
            `before was ${before.steps}. A step cap bounds it whichever way it turns out.`,
          occurrences: 1,
          firstSeenAt: run.firstSeen,
          spend: 0n,
        });
      }

      if (
        run.depth > Math.max(before.depth * SPIKE_MULTIPLE, before.depth + 1) &&
        !reported.has(`depth:${run.agentId}`)
      ) {
        reported.add(`depth:${run.agentId}`);
        out.push({
          kind: "depth-spike",
          agentId: run.agentId,
          headline: `${run.agentId} delegated ${run.depth} levels deep, further than it ever has`,
          evidence:
            `Run ${run.runId} reached depth ${run.depth}; this agent had never passed ` +
            `${before.depth}. Work handed on repeatedly is how a small task becomes a large bill.`,
          occurrences: 1,
          firstSeenAt: run.firstSeen,
          spend: 0n,
        });
      }
    }
    return out;
  }

  #newnessNote(n: number, days: number): string {
    return (
      `${n} time(s) in this window, and never in the ${days} days before it. New behaviour ` +
      "is usually a deploy rather than a problem, so this is worth a glance rather than an alarm."
    );
  }
}
