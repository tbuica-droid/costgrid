import { type HumanBaseline, mulDiv, type Nanodollars, toUsdString } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * What the owner types in for the results screen: how long a finished job
 * takes a person and what their hour costs, and, for agents known only from
 * provider usage reports, how many jobs finished in a month.
 *
 * Both are the owner's estimates. The screen labels them so, and they are
 * kept here, apart from anything CostGrid measured.
 */

export interface PersonCost {
  readonly minutes: number;
  /** Fully loaded cost of one hour, in nanodollars. */
  readonly hourlyRate: Nanodollars;
  readonly updatedAt: number;
}

export interface JobCount {
  /** `YYYY-MM`, UTC. */
  readonly month: string;
  readonly finished: number;
  /** Null when the owner did not say. */
  readonly notFinished: number | null;
  readonly updatedAt: number;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** A week of minutes: longer than any one job a person does by hand. */
export const MAX_PERSON_MINUTES = 10_080;
/** $10,000 an hour: well above any real rate, low enough to catch a typo of a yearly salary. */
export const MAX_HOURLY_RATE: Nanodollars = 10_000n * 1_000_000_000n;
const MAX_JOBS = 100_000_000;

export const isMonth = (value: unknown): value is string => typeof value === "string" && MONTH.test(value);

/** What one finished job costs done by a person, as the engine takes it. */
export function personBaseline(p: PersonCost): HumanBaseline {
  return {
    costPerOutcome: mulDiv(p.hourlyRate, BigInt(p.minutes), 60n),
    source: "Entered by the owner",
    date: new Date(p.updatedAt).toISOString().slice(0, 10),
    method: `${p.minutes} minutes at $${toUsdString(p.hourlyRate, 2)} an hour`,
  };
}

export class JobInputs {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  personCosts(tenantId: string): Map<string, PersonCost> {
    const rows = this.#db
      .prepare(
        `SELECT agent_id AS agentId, minutes, hourly_rate AS hourlyRate, updated_at AS updatedAt
         FROM agent_person_cost WHERE tenant_id = ?`,
      )
      .safeIntegers(true)
      .all(tenantId) as { agentId: string; minutes: bigint; hourlyRate: bigint; updatedAt: bigint }[];
    return new Map(
      rows.map((r) => [r.agentId, { minutes: Number(r.minutes), hourlyRate: r.hourlyRate, updatedAt: Number(r.updatedAt) }]),
    );
  }

  /** Sets, or with `null` clears, an agent's person cost. False when there is no such agent. */
  setPersonCost(tenantId: string, agentId: string, cost: { minutes: number; hourlyRate: Nanodollars } | null): boolean {
    if (!this.#agentExists(tenantId, agentId)) return false;
    if (cost === null) {
      this.#db.prepare("DELETE FROM agent_person_cost WHERE tenant_id = ? AND agent_id = ?").run(tenantId, agentId);
      return true;
    }
    if (!Number.isSafeInteger(cost.minutes) || cost.minutes < 1 || cost.minutes > MAX_PERSON_MINUTES) {
      throw new RangeError(`minutes must be a whole number from 1 to ${MAX_PERSON_MINUTES}`);
    }
    if (cost.hourlyRate <= 0n || cost.hourlyRate > MAX_HOURLY_RATE) throw new RangeError("hourly rate is out of range");
    this.#db
      .prepare(
        `INSERT INTO agent_person_cost (tenant_id, agent_id, minutes, hourly_rate, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
           minutes = excluded.minutes, hourly_rate = excluded.hourly_rate, updated_at = excluded.updated_at`,
      )
      .run(tenantId, agentId, cost.minutes, cost.hourlyRate, Date.now());
    return true;
  }

  /** Every month the owner gave a count for, per agent, newest first. */
  jobCounts(tenantId: string): Map<string, JobCount[]> {
    const rows = this.#db
      .prepare(
        `SELECT agent_id AS agentId, month, finished, not_finished AS notFinished, updated_at AS updatedAt
         FROM agent_job_counts WHERE tenant_id = ? ORDER BY agent_id, month DESC`,
      )
      .all(tenantId) as (JobCount & { agentId: string })[];
    const byAgent = new Map<string, JobCount[]>();
    for (const { agentId, ...count } of rows) {
      const list = byAgent.get(agentId);
      if (list) list.push(count);
      else byAgent.set(agentId, [count]);
    }
    return byAgent;
  }

  /** Sets, or with `null` clears, one month's count. False when there is no such agent. */
  setJobCount(
    tenantId: string,
    agentId: string,
    month: string,
    count: { finished: number; notFinished: number | null } | null,
  ): boolean {
    if (!isMonth(month)) throw new RangeError("month must be YYYY-MM");
    if (!this.#agentExists(tenantId, agentId)) return false;
    if (count === null) {
      this.#db
        .prepare("DELETE FROM agent_job_counts WHERE tenant_id = ? AND agent_id = ? AND month = ?")
        .run(tenantId, agentId, month);
      return true;
    }
    for (const value of [count.finished, count.notFinished]) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > MAX_JOBS)) {
        throw new RangeError("job counts must be whole numbers of zero or more");
      }
    }
    this.#db
      .prepare(
        `INSERT INTO agent_job_counts (tenant_id, agent_id, month, finished, not_finished, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, agent_id, month) DO UPDATE SET
           finished = excluded.finished, not_finished = excluded.not_finished, updated_at = excluded.updated_at`,
      )
      .run(tenantId, agentId, month, count.finished, count.notFinished, Date.now());
    return true;
  }

  #agentExists(tenantId: string, agentId: string): boolean {
    return this.#db.prepare("SELECT 1 FROM agents WHERE tenant_id = ? AND id = ?").get(tenantId, agentId) !== undefined;
  }
}
