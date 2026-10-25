import { formatRatio, formatUsdPerOutcome, usd, ZERO_USAGE } from "@costgrid/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentsRepository,
  type Db,
  ImportsRepository,
  JobInputs,
  openDatabase,
  personBaseline,
  RunOutcomes,
  SourcesRepository,
} from "../src/index.js";

/**
 * What the owner types in for the results screen: a person's time per job,
 * and job counts for agents the proxy never sees. Both are estimates; the
 * point here is that they reach the engine intact and go with their agent.
 */

const T = "t1";
const DAY = 86_400_000;

describe("JobInputs", () => {
  let db: Db;
  let agents: AgentsRepository;
  let inputs: JobInputs;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', 0)").run(T);
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t2', 'Other', 0)").run();
    agents = new AgentsRepository(db);
    inputs = new JobInputs(db);
  });

  it("keeps a person cost per agent, refuses nonsense, and goes with the agent", () => {
    const id = agents.create(T, { name: "Support bot" })!;
    expect(inputs.setPersonCost(T, id, { minutes: 12, hourlyRate: usd("40") })).toBe(true);
    const cost = inputs.personCosts(T).get(id)!;
    expect(cost).toMatchObject({ minutes: 12, hourlyRate: usd("40") });
    expect(personBaseline(cost)).toMatchObject({ costPerOutcome: usd("8"), method: "12 minutes at $40.00 an hour" });

    expect(inputs.setPersonCost("t2", id, { minutes: 12, hourlyRate: usd("40") })).toBe(false);
    expect(inputs.setPersonCost(T, "nobody", { minutes: 12, hourlyRate: usd("40") })).toBe(false);
    expect(() => inputs.setPersonCost(T, id, { minutes: 0, hourlyRate: usd("40") })).toThrow(RangeError);
    expect(() => inputs.setPersonCost(T, id, { minutes: 12, hourlyRate: usd("50000") })).toThrow(RangeError);

    expect(inputs.setPersonCost(T, id, null)).toBe(true);
    expect(inputs.personCosts(T).size).toBe(0);
    inputs.setPersonCost(T, id, { minutes: 5, hourlyRate: usd("30") });
    agents.remove(T, id);
    expect(inputs.personCosts(T).size).toBe(0);
  });

  it("keeps job counts per month, newest first", () => {
    const id = agents.create(T, { name: "Writer" })!;
    inputs.setJobCount(T, id, "2026-08", { finished: 40, notFinished: null });
    inputs.setJobCount(T, id, "2026-09", { finished: 50, notFinished: 10 });
    inputs.setJobCount(T, id, "2026-09", { finished: 55, notFinished: 5 });
    expect(inputs.jobCounts(T).get(id)!.map((c) => [c.month, c.finished, c.notFinished])).toEqual([
      ["2026-09", 55, 5],
      ["2026-08", 40, null],
    ]);
    expect(() => inputs.setJobCount(T, id, "2026-13", { finished: 1, notFinished: null })).toThrow(RangeError);
    expect(() => inputs.setJobCount(T, id, "2026-09", { finished: -1, notFinished: null })).toThrow(RangeError);
    expect(inputs.setJobCount(T, id, "2026-09", null)).toBe(true);
    expect(inputs.jobCounts(T).get(id)!.map((c) => c.month)).toEqual(["2026-08"]);
  });

  it("prices an agent known only from provider reports from its newest counted month", () => {
    const writer = agents.create(T, { name: "Writer", purposeId: "content", purposeVersion: "2" })!;
    const row = (day: string, cost: string) => ({
      provider: "openai" as const,
      day,
      model: "gpt-6",
      usage: { ...ZERO_USAGE, inputTokens: 1000 },
      requests: 0,
      costCatalog: usd(cost),
      priced: true,
      sourceKind: "project" as const,
      sourceId: "proj_w",
    });
    new ImportsRepository(db).putRows(
      T,
      "openai",
      { fromDay: "2026-08-31", toDay: "2026-10-01" },
      [row("2026-08-31", "100"), row("2026-09-01", "20"), row("2026-09-30", "30"), row("2026-10-01", "100")],
      "admin-api",
    );
    new SourcesRepository(db).upsertSources(T, [{ provider: "openai", kind: "project", id: "proj_w" }], {
      first: "2026-08-31",
      last: "2026-10-01",
    });
    agents.assign(T, { provider: "openai", kind: "project", id: "proj_w" }, { agentId: writer, shared: false, by: "owner" });

    const now = Date.UTC(2026, 9, 10);
    const range = { from: now - 30 * DAY, to: now };
    expect(new RunOutcomes(db).forTenant(T, range, now).noOutcomeData).toEqual([
      { id: writer, name: "Writer", counts: [] },
    ]);

    inputs.setJobCount(T, writer, "2026-09", { finished: 100, notFinished: 25 });
    inputs.setPersonCost(T, writer, { minutes: 6, hourlyRate: usd("30") });
    const [only] = new RunOutcomes(db).forTenant(T, range, now).noOutcomeData;
    expect(only!.latest!.month).toBe("2026-09");
    expect(only!.latest!.cost).toBe(usd("50"));
    const result = only!.latest!.result;
    expect(result.mode).toBe("aggregate");
    expect(formatUsdPerOutcome((result.lcso.lcso1 as { value: never }).value, 2)).toBe("0.50");
    expect(result.rates.success).toMatchObject({ reported: true });
    // $0.50 against a person's $3.00.
    expect(formatRatio((result.her as { value: { ratio: never } }).value.ratio, 3)).toBe("0.167");
  });
});
