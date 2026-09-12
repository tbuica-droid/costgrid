import { priceUsage, usd, ZERO_USAGE } from "@costgrid/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Analytics } from "../src/analytics.js";
import { openDatabase } from "../src/database.js";
import { CostGridRepository } from "../src/repositories.js";
import { buildStatement, monthOf, monthRange, previousMonth, statementToCsv } from "../src/statement.js";

describe("month arithmetic", () => {
  it("spans a calendar month in UTC, half-open", () => {
    const range = monthRange("2026-09");
    expect(new Date(range.from).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    // Half-open, so it ends where October begins and the two tile exactly.
    expect(new Date(range.to).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(monthRange("2026-10").from).toBe(range.to);
  });

  it("handles the year boundary in both directions", () => {
    expect(new Date(monthRange("2026-12").to).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(previousMonth("2026-01")).toBe("2025-12");
  });

  it("handles a leap February", () => {
    const days = (monthRange("2028-02").to - monthRange("2028-02").from) / 86_400_000;
    expect(days).toBe(29);
  });

  it("names the month a timestamp falls in", () => {
    expect(monthOf(Date.UTC(2026, 8, 30, 23, 59, 59))).toBe("2026-09");
    expect(monthOf(Date.UTC(2026, 9, 1, 0, 0, 0))).toBe("2026-10");
  });

  it("rejects anything that is not YYYY-MM", () => {
    for (const bad of ["2026", "2026-9", "2026-13", "2026-00", "sept", ""]) {
      expect(() => monthRange(bad)).toThrow(/month must be/);
    }
  });
});

describe("monthly statement", () => {
  let db: ReturnType<typeof openDatabase>;
  let repository: CostGridRepository;
  let analytics: Analytics;

  /** 1M in, 1M out, so a rate reads straight off as dollars. */
  const record = (
    at: number,
    over: { model?: string; agent?: string; department?: string; outcome?: "ok" | "error" | "blocked" } = {},
  ) => {
    const model = over.model ?? "claude-opus-5";
    const outcome = over.outcome ?? "ok";
    const usage =
      outcome === "ok"
        ? { ...ZERO_USAGE, inputTokens: 1_000_000, outputTokens: 1_000_000 }
        : ZERO_USAGE;
    const priced = priceUsage(model, usage);
    repository.recordCall({
      id: `${at}-${Math.random()}`,
      tenantId: "t1",
      agentId: over.agent ?? "chat-bot",
      department: over.department ?? "Engineering",
      provider: "anthropic",
      model,
      startedAt: at,
      durationMs: 10,
      streamed: false,
      usage,
      cost: priced.cost,
      priced: priced.priced,
      outcome,
    });
  };

  const SEPT = Date.UTC(2026, 8, 10);
  const AUG = Date.UTC(2026, 7, 10);
  /** Well after September closed, so the month is complete. */
  const NOW = Date.UTC(2026, 10, 1);

  const statement = (month = "2026-09", now = NOW) =>
    buildStatement({ analytics, repository, tenantId: "t1", month, now });

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    repository = new CostGridRepository(db);
    analytics = new Analytics(db);
    repository.createTenant("Acme", "t1");
  });

  afterEach(() => db.close());

  it("totals only the month it names", () => {
    record(AUG);
    record(SEPT);
    // The last millisecond of September is in; the first of October is not.
    record(Date.UTC(2026, 8, 30, 23, 59, 59, 999));
    record(Date.UTC(2026, 9, 1));

    const s = statement();
    expect(s.total).toBe(usd("60.00")); // two Opus calls at $30
    expect(s.previousTotal).toBe(usd("30.00"));
    expect(s.change).toBe(1); // doubled
  });

  it("reports no change rather than an infinite one for a new line", () => {
    record(SEPT, { agent: "brand-new" });

    const s = statement();
    // Nothing to compare against: a line that did not exist last month has not
    // grown by infinity, and a percentage there would be a lie.
    expect(s.change).toBeUndefined();
    expect(s.byAgent[0]?.change).toBeUndefined();
    expect(s.byAgent[0]?.previousCost).toBe(0n);
  });

  it("attributes spend to teams, agents and models with shares that sum", () => {
    record(SEPT, { department: "Engineering", agent: "chat-bot" });
    record(SEPT, { department: "Support", agent: "triage", model: "claude-haiku-4-5" });

    const s = statement();
    expect(s.total).toBe(usd("36.00")); // $30 Opus + $6 Haiku
    expect(s.byDepartment.map((l) => l.key)).toEqual(["Engineering", "Support"]);
    const shares = s.byDepartment.reduce((sum, l) => sum + l.share, 0);
    expect(shares).toBeCloseTo(1, 10);
    expect(s.byModel).toHaveLength(2);
  });

  it("marks a month still in progress and projects from the run rate", () => {
    record(Date.UTC(2026, 8, 1));
    record(Date.UTC(2026, 8, 2));

    // Three days into a thirty-day month, $60 spent.
    const s = statement("2026-09", Date.UTC(2026, 8, 4));
    expect(s.partial).toBe(true);
    expect(s.daysElapsed).toBeCloseTo(3, 6);
    expect(s.daysInMonth).toBe(30);
    expect(s.projected).toBe(usd("600.00"));
  });

  it("does not project for a finished month", () => {
    record(SEPT);
    expect(statement().partial).toBe(false);
    expect(statement().projected).toBeUndefined();
  });

  it("does not project a month that has not started", () => {
    // A future month has no run rate to extrapolate from, and dividing by the
    // zero days elapsed would produce Infinity.
    const s = statement("2026-12", NOW);
    expect(s.daysElapsed).toBe(0);
    expect(s.projected).toBeUndefined();
    expect(s.total).toBe(0n);
  });

  it("counts blocked, errored and unpriced calls apart from spend", () => {
    record(SEPT);
    record(SEPT, { outcome: "blocked" });
    record(SEPT, { outcome: "error" });
    record(SEPT, { model: "claude-not-in-catalog" });

    const s = statement();
    expect(s.blockedCalls).toBe(1);
    expect(s.erroredCalls).toBe(1);
    expect(s.unpricedCalls).toBe(1);
    // A refused call costs nothing and an unpriced one is not guessed at.
    expect(s.total).toBe(usd("30.00"));
  });

  // ------------------------------------------------------------- budgets

  const budget = (
    limit: string,
    window: "day" | "month",
    scope: Parameters<CostGridRepository["createPolicy"]>[1]["scope"] = { kind: "tenant" },
  ) =>
    repository.createPolicy("t1", {
      name: `${window}ly cap`,
      scope,
      rule: { kind: "budget", window, limit: usd(limit) },
      action: "block",
      enabled: true,
    });

  it("measures a monthly cap against the month", () => {
    budget("100.00", "month");
    record(SEPT);
    record(SEPT);

    const [status] = statement().budgets;
    expect(status?.actual).toBe(usd("60.00"));
    expect(status?.used).toBeCloseTo(0.6, 10);
    expect(status?.breachedDays).toBeUndefined();
  });

  it("measures a daily cap against its worst day, not the month", () => {
    budget("40.00", "day");
    // $60 on the 10th, $30 on the 11th: over on one day only.
    record(SEPT);
    record(SEPT);
    record(Date.UTC(2026, 8, 11));

    const [status] = statement().budgets;
    // A $40/day cap and $90 of monthly spend say nothing about each other.
    expect(status?.actual).toBe(usd("60.00"));
    expect(status?.breachedDays).toBe(1);
  });

  it("scopes a budget to its own department", () => {
    budget("100.00", "month", { kind: "department", department: "Support" });
    record(SEPT, { department: "Engineering" });
    record(SEPT, { department: "Support" });

    const [status] = statement().budgets;
    expect(status?.scope).toBe("dept:Support");
    expect(status?.actual).toBe(usd("30.00")); // not the tenant's $60
  });

  it("leaves disabled and non-budget policies out", () => {
    const id = budget("100.00", "month");
    repository.setPolicyEnabled(id, false);
    repository.createPolicy("t1", {
      name: "allowlist",
      scope: { kind: "tenant" },
      rule: { kind: "model-allowlist", models: ["claude-haiku-4-5"] },
      action: "block",
      enabled: true,
    });

    expect(statement().budgets).toHaveLength(0);
  });

  // ----------------------------------------------------------------- CSV

  describe("CSV export", () => {
    it("carries the totals a spreadsheet needs", () => {
      record(SEPT, { department: "Engineering" });
      record(AUG, { department: "Engineering" });
      budget("100.00", "month");

      const csv = statementToCsv(statement());
      const lines = csv.split("\n");

      expect(lines[0]).toBe("CostGrid statement,2026-09");
      expect(csv).toContain("section,item,calls,cost_usd,share_pct,previous_cost_usd,change_pct");
      expect(csv).toContain("total,all spend,1,30.000000,100.0,30.000000,0.0");
      expect(csv).toContain("department,Engineering,1,30.000000,100.0,30.000000,0.0");
      expect(csv).toContain("budget,scope,window,action,limit_usd,actual_usd,used_pct,days_over");
      expect(csv).toContain("monthly cap,whole account,month,block,100.000000,30.000000,30.0,");
      expect(csv.endsWith("\n")).toBe(true);
    });

    it("quotes a team name containing a comma", () => {
      // Otherwise "Sales, EMEA" splits into two columns and the rows quietly
      // stop summing to the total.
      record(SEPT, { department: 'Sales, "EMEA"' });

      const csv = statementToCsv(statement());
      expect(csv).toContain('department,"Sales, ""EMEA""",1,30.000000');
    });

    it("keeps sub-cent lines visible", () => {
      // Six decimals, because rounding a $0.004 agent to 0.00 would make the
      // rows stop adding up to the total.
      repository.recordCall({
        id: "tiny",
        tenantId: "t1",
        agentId: "cheap",
        department: "Engineering",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        startedAt: SEPT,
        durationMs: 1,
        streamed: false,
        usage: { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 100 },
        cost: priceUsage("claude-haiku-4-5", {
          ...ZERO_USAGE,
          inputTokens: 1_000,
          outputTokens: 100,
        }).cost,
        priced: true,
        outcome: "ok",
      });

      expect(statementToCsv(statement())).toContain("agent,cheap,1,0.001500");
    });
  });
});
