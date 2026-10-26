import { usd } from "@costgrid/core";
import type { OutcomeSummary, Statement } from "@costgrid/db";
import { describe, expect, it } from "vitest";
import { renderStatementHtml } from "../src/statement-html.js";

const BASE: Statement = {
  month: "2026-09",
  range: { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) },
  generatedAt: Date.UTC(2026, 9, 1),
  partial: false,
  daysElapsed: 30,
  daysInMonth: 30,
  total: usd("8400.00"),
  previousTotal: usd("7000.00"),
  change: 0.2,
  projected: undefined,
  calls: 120_000,
  blockedCalls: 0,
  erroredCalls: 0,
  unpricedCalls: 0,
  cacheHitRatio: 0.28,
  byDepartment: [
    { key: "Support", cost: usd("5000.00"), calls: 80_000, share: 0.6, previousCost: usd("4000.00"), change: 0.25 },
    { key: "Research", cost: usd("3400.00"), calls: 40_000, share: 0.4, previousCost: 0n, change: undefined },
  ],
  byAgent: [],
  byModel: [],
  routing: { routedCalls: 0, dryRunCalls: 0, realisedSaving: 0n, potentialSaving: 0n },
  budgets: [],
  rates: [],
  imported: undefined,
};

const render = (over: Partial<Statement> = {}, outcomes?: OutcomeSummary) =>
  renderStatementHtml({ ...BASE, ...over }, { company: "Acme Ltd", outcomes });

describe("the statement as a document", () => {
  it("leads with the figure and the direction", () => {
    const html = render();
    expect(html).toContain("$8,400.00 on AI in September 2026, up 20% on the month before.");
    expect(html).toContain("Acme Ltd");
  });

  it("names the period in the title, so a saved file is identifiable", () => {
    expect(render()).toContain("<title>AI spending, Acme Ltd, September 2026</title>");
  });

  it("is one self-contained file", () => {
    const html = render();
    // It has to survive being emailed and opened with no network.
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/<script/);
    expect(html).not.toContain("fonts.googleapis");
  });

  it("escapes a company name rather than injecting it", () => {
    const html = renderStatementHtml(BASE, { company: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("colours rising spend as bad and falling spend as good", () => {
    expect(render({ change: 0.25 })).toMatch(/class="over">\+25%/);
    expect(render({ change: -0.3 })).toMatch(/class="saved">-30%/);
  });

  it("says a line is new rather than inventing a percentage", () => {
    // A team that did not exist last month has not grown by infinity.
    expect(render()).toContain(">new<");
  });

  it("omits the savings section when no rule has run", () => {
    expect(render()).not.toContain("What the rules did");
  });

  it("shows savings, and keeps taken apart from available", () => {
    const html = render({
      routing: {
        routedCalls: 4_000,
        dryRunCalls: 900,
        realisedSaving: usd("612.40"),
        potentialSaving: usd("210.00"),
      },
    });
    expect(html).toContain("What the rules did");
    expect(html).toContain("$612.40");
    expect(html).toContain("watch-only mode");
    // The caveat travels with the number, every time.
    expect(html).toContain("estimate rather than a measurement");
  });

  it("omits the outcome section until something is reported", () => {
    expect(render()).not.toContain("What the money bought");
  });

  it("shows cost per result, and warns when the sample is thin", () => {
    const outcomes: OutcomeSummary = {
      reportedRuns: 40, succeeded: 36, failed: 4,
      costOfSuccess: usd("900.00"), costOfFailure: usd("100.00"),
      costPerSuccess: usd("25.00"),
      totalRuns: 900, truncatedRuns: 0, erroredRuns: 0, runSpend: usd("1000.00"),
    };
    const html = render({}, outcomes);
    expect(html).toContain("What the money bought");
    expect(html).toContain("under half the runs");
  });

  it("does not warn when the sample covers most runs", () => {
    const outcomes: OutcomeSummary = {
      reportedRuns: 800, succeeded: 700, failed: 100,
      costOfSuccess: usd("900.00"), costOfFailure: usd("100.00"),
      costPerSuccess: usd("1.28"),
      totalRuns: 900, truncatedRuns: 0, erroredRuns: 0, runSpend: usd("1000.00"),
    };
    expect(render({}, outcomes)).not.toContain("under half the runs");
  });

  it("says when the month is not finished", () => {
    const html = render({ partial: true, daysElapsed: 12.5, projected: usd("20160.00") });
    expect(html).toContain("is not finished");
    expect(html).toContain("12.5 of 30 days");
    expect(html).toContain("a projection, not a measurement");
  });

  it("says unpriced calls understate the total rather than hiding them", () => {
    const html = render({ unpricedCalls: 42 });
    expect(html).toContain("42 call(s) could not be priced");
    expect(html).toContain("understated rather than guessed at");
  });

  it("declares a negotiated rate, so the figures can be reconciled", () => {
    const html = render({ rates: [{ provider: "anthropic", discountPercent: 18, source: "derived" }] });
    expect(html).toContain("18% off list");
    expect(html).toContain("match your invoice");
  });

  it("escapes every value it prints, including a rate's source and a budget's window", () => {
    const html = render({
      rates: [{ provider: "anthropic", discountPercent: 18, source: "<img src=x onerror=alert(1)>" }],
      byAgent: [{ key: "<script>alert('a')</script>", cost: usd("1.00"), calls: 1, share: 1, previousCost: 0n, change: undefined }],
      budgets: [
        {
          policyId: "p1",
          policyName: "cap",
          scope: "everything",
          window: "<b>month</b>" as "month",
          action: "block",
          limit: usd("10.00"),
          actual: usd("1.00"),
        } as Statement["budgets"][number],
      ],
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>month</b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#39;a&#39;)&lt;/script&gt;");
  });

  it("keeps imported provider totals apart from metered ones", () => {
    const html = render({
      imported: { catalogCost: usd("100.00"), reportedCost: usd("90.00"), requests: 500 },
    });
    expect(html).toContain("held separately");
  });

  it("prints", () => {
    // A report nobody can put on paper is not the artefact this is for.
    expect(render()).toContain("@media print");
    expect(render()).toContain("@page");
  });
});
