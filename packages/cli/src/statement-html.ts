import { formatPercent, formatUsdPerOutcome, type Nanodollars, toUsdString } from "@costgrid/core";
import { BASIS_LABELS, type OutcomeSummary, type Statement, type StatementLine, VERDICT_LINES } from "@costgrid/db";

/**
 * The statement as one page someone can read who has never opened the
 * dashboard.
 *
 * Everything the product knows already existed in `Statement`. What was
 * missing was an artefact to put in front of whoever signs the budget, and
 * that is a different job from the terminal report: it names a company and a
 * period, leads with the figure that decides the renewal, and survives being
 * forwarded.
 *
 * HTML rather than a PDF binary, for three reasons. It needs no dependency, so
 * nothing new has to be trusted or audited to produce a document that goes to
 * a customer's finance team. Every browser prints it to PDF. And a text format
 * can be diffed and inspected, which matters for a file whose whole purpose is
 * that its numbers can be checked.
 *
 * Self-contained on purpose: one file, no external stylesheet, no webfont, no
 * script. It has to survive being attached to an email and opened on a machine
 * with no network.
 */

/**
 * Money with thousands separators.
 *
 * The terminal report deliberately does not group, because its columns are
 * monospace and aligned on the decimal already. This is a document going to a
 * finance team, where "$8400.00" reads like a typo and "$8,400.00" reads like
 * a number. Grouping is applied to the integer part only, so the exact
 * fractional cents the rest of the product is careful about survive intact.
 */
function money(n: Nanodollars, dp = 2): string {
  const raw = toUsdString(n, dp);
  const negative = raw.startsWith("-");
  const [whole, fraction] = (negative ? raw.slice(1) : raw).split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}${fraction ? `.${fraction}` : ""}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A signed change, coloured by what it means rather than by its sign. */
function delta(change: number | undefined): string {
  if (change === undefined) return '<span class="flat">new</span>';
  const pct = change * 100;
  if (Math.abs(pct) < 0.5) return '<span class="flat">no change</span>';
  const cls = pct > 0 ? "over" : "saved";
  return `<span class="${cls}">${pct > 0 ? "+" : ""}${pct.toFixed(0)}%</span>`;
}

function rows(lines: readonly StatementLine[]): string {
  if (lines.length === 0) return '<tr><td colspan="4" class="muted">Nothing recorded.</td></tr>';
  return lines
    .map(
      (l) => `<tr>
        <td>${esc(l.key)}</td>
        <td class="num">${money(l.cost)}</td>
        <td class="num">${l.calls.toLocaleString("en-US")}</td>
        <td class="num">${delta(l.change)}</td>
      </tr>`,
    )
    .join("");
}

function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const names = ["January","February","March","April","May","June",
                 "July","August","September","October","November","December"];
  return `${names[(m ?? 1) - 1]} ${y}`;
}

export interface StatementHtmlOptions {
  /** Whose statement this is. Printed at the top, as on an invoice. */
  readonly company: string;
  readonly outcomes?: OutcomeSummary | undefined;
}

export function renderStatementHtml(s: Statement, options: StatementHtmlOptions): string {
  const period = monthName(s.month);

  /*
   * The headline. Whoever reads only the first line should get the answer,
   * which is what this cost and whether it moved.
   */
  const headline =
    s.change === undefined
      ? `${money(s.total)} on AI in ${period}.`
      : `${money(s.total)} on AI in ${period}, ${
          s.change > 0.005 ? "up" : s.change < -0.005 ? "down" : "level"
        } ${Math.abs(s.change * 100).toFixed(0)}% on the month before.`;

  const caveats: string[] = [];
  if (s.partial) {
    caveats.push(
      `${period} is not finished. These figures cover ${s.daysElapsed.toFixed(1)} of ` +
        `${s.daysInMonth} days and will change.`,
    );
  }
  if (s.unpricedCalls > 0) {
    caveats.push(
      `${s.unpricedCalls} call(s) could not be priced, usually an uncatalogued model. ` +
        "They are counted as $0, so the total above is understated rather than guessed at.",
    );
  }
  if (s.erroredCalls > 0) {
    caveats.push(`${s.erroredCalls} call(s) failed upstream and are not billed here.`);
  }
  for (const r of s.rates) {
    caveats.push(
      `Figures use your negotiated ${r.provider} rate, ${r.discountPercent}% off list ` +
        `(${r.source}), so they match your invoice rather than the public price list.`,
    );
  }
  if (s.imported) {
    caveats.push(
      "Provider-reported totals for the same period are held separately from these " +
        "metered figures, because they carry no team attribution and folding them in " +
        "would misattribute spend.",
    );
  }

  const o = options.outcomes;
  const outcomeBlock =
    o && o.reportedRuns > 0
      ? `<section>
      <h2>What the money bought</h2>
      <div class="grid">
        <div class="stat"><div class="label">Reported on</div><div class="value">${o.reportedRuns.toLocaleString("en-US")}<span class="unit"> of ${o.totalRuns.toLocaleString("en-US")} runs</span></div></div>
        <div class="stat"><div class="label">Worked</div><div class="value">${((o.succeeded / o.reportedRuns) * 100).toFixed(0)}%</div></div>
        ${o.costPerSuccess !== undefined ? `<div class="stat"><div class="label">Cost per result</div><div class="value">${money(o.costPerSuccess, 4)}</div></div>` : ""}
      </div>
      ${o.reportedRuns < o.totalRuns / 2 ? '<p class="note">Read that rate carefully. It covers under half the runs in this period.</p>' : ""}
    </section>`
      : "";

  const jobRows = s.jobs?.rows ?? [];
  const jobsBlock = jobRows.length || s.jobs?.notJudged.length
    ? `<section>
      <h2>Did the jobs get done?</h2>
      <table>
        <thead><tr><th>Agent</th><th class="num">Finished</th><th class="num">Not finished</th><th class="num">Per finished job</th><th>In plain words</th></tr></thead>
        <tbody>${jobRows
          .map(
            (r) => `<tr><td>${esc(r.name ?? r.agentId)}<br /><small>${esc(BASIS_LABELS[r.basis])}</small></td>
              <td class="num">${r.finished.toLocaleString("en-US")}</td><td class="num">${r.notFinished.toLocaleString("en-US")}</td>
              <td class="num">${r.costPerFinished === undefined ? "&mdash;" : `$${formatUsdPerOutcome(r.costPerFinished, 2)}`}</td>
              <td>${esc(VERDICT_LINES[r.verdict])}${r.failureShare === undefined || r.finished === 0 ? "" : ` ${formatPercent(r.failureShare, 0)}% of its spend was on jobs that didn&rsquo;t finish.`}</td></tr>`,
          )
          .join("")}</tbody>
      </table>
      ${s.jobs!.notJudged.length ? `<p class="note">Not judged, because their purpose predates automatic detection: ${s.jobs!.notJudged.map((a) => esc(a.name ?? a.agentId)).join(", ")}.</p>` : ""}
      <p class="note">Indicative. Failed and retried attempts are charged to the jobs that worked (LCSO method v${esc(s.jobs!.methodologyVersion)}). Where it says &ldquo;inferred&rdquo;, CostGrid judged each job from how the agent behaved; a report from your software makes it exact.</p>
    </section>`
    : "";

  const savings = s.routing;
  const savingsBlock =
    savings.routedCalls > 0 || savings.dryRunCalls > 0
      ? `<section>
      <h2>What the rules did</h2>
      <table>
        <tbody>
          ${savings.routedCalls > 0 ? `<tr><td>Saved by moving work to cheaper models</td><td class="num saved">${money(savings.realisedSaving)}</td><td class="num muted">${savings.routedCalls.toLocaleString("en-US")} calls</td></tr>` : ""}
          ${savings.dryRunCalls > 0 ? `<tr><td>Available but not yet taken, rules still in watch-only mode</td><td class="num muted">${money(savings.potentialSaving)}</td><td class="num muted">${savings.dryRunCalls.toLocaleString("en-US")} calls</td></tr>` : ""}
          ${s.blockedCalls > 0 ? `<tr><td>Calls refused before they were made</td><td class="num">&mdash;</td><td class="num muted">${s.blockedCalls.toLocaleString("en-US")} calls</td></tr>` : ""}
        </tbody>
      </table>
      <p class="note"><strong>How the saving is worked out.</strong> When a rule moves a call to a
      cheaper model, CostGrid prices the same token counts on the model that was originally
      asked for and records the difference. It is an estimate rather than a measurement,
      because token counts are not identical across models. Money already saved is kept
      separate from money a watch-only rule says was available.</p>
    </section>`
      : "";

  const budgetBlock =
    s.budgets.length > 0
      ? `<section>
      <h2>Budgets</h2>
      <table>
        <thead><tr><th>Cap</th><th class="num">Limit</th><th class="num">Used</th><th class="num">Status</th></tr></thead>
        <tbody>
          ${s.budgets
            .map(
              (b) => `<tr>
            <td>${esc(b.policyName)} <span class="muted">${esc(b.scope)}, per ${b.window}</span></td>
            <td class="num">${money(b.limit)}</td>
            <td class="num">${b.used === undefined ? "&mdash;" : `${(b.used * 100).toFixed(0)}%`}</td>
            <td class="num">${b.used !== undefined && b.used > 1 ? '<span class="over">over</span>' : '<span class="saved">within</span>'}${b.fallbackModel ? `<span class="muted">, falls back to ${esc(b.fallbackModel)}</span>` : ""}</td>
          </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </section>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AI spending, ${esc(options.company)}, ${period}</title>
<style>
  :root {
    --ink:#16130f; --soft:#4a443c; --faint:#8a8175;
    --paper:#faf8f4; --rule-hair:#e8e3d9; --rule:#d5cec1;
    --over:#a63a22; --saved:#2e6b4f;
    --serif: Georgia, "Times New Roman", serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; padding:48px 40px 64px; background:var(--paper); color:var(--ink);
    font-family:var(--sans); font-size:14px; line-height:1.6;
    font-variant-numeric: lining-nums tabular-nums;
    max-width:820px; margin-inline:auto;
  }
  header { border-bottom:2px solid var(--ink); padding-bottom:20px; margin-bottom:32px; }
  .brand { font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color:var(--faint); }
  h1 { font-family:var(--serif); font-weight:400; font-size:30px; line-height:1.15;
       letter-spacing:-0.02em; margin:12px 0 4px; }
  .who { color:var(--soft); font-size:14px; }
  h2 { font-family:var(--serif); font-weight:400; font-size:19px; margin:34px 0 12px;
       padding-bottom:7px; border-bottom:1px solid var(--rule); }
  section { break-inside:avoid; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th { text-align:left; font-size:10.5px; letter-spacing:0.08em; text-transform:uppercase;
       color:var(--faint); font-weight:500; padding:0 10px 7px 0; border-bottom:1px solid var(--rule); }
  td { padding:8px 10px 8px 0; border-bottom:1px solid var(--rule-hair); vertical-align:baseline; }
  th:last-child, td:last-child { padding-right:0; }
  .num { text-align:right; font-variant-numeric:lining-nums tabular-nums; }
  tfoot td { border-top:2px solid var(--ink); border-bottom:none; font-weight:600; }
  .over { color:var(--over); }
  .saved { color:var(--saved); }
  .flat, .muted { color:var(--faint); }
  .grid { display:flex; flex-wrap:wrap; gap:36px; margin:4px 0 6px; }
  .stat .label { font-size:10.5px; letter-spacing:0.08em; text-transform:uppercase; color:var(--faint); }
  .stat .value { font-family:var(--serif); font-size:26px; line-height:1.2; }
  .stat .unit { font-family:var(--sans); font-size:13px; color:var(--soft); }
  .note { font-size:12.5px; line-height:1.55; color:var(--soft);
          border-left:2px solid var(--rule); padding-left:14px; margin:14px 0 0; }
  footer { margin-top:44px; padding-top:16px; border-top:1px solid var(--rule);
           font-size:11.5px; color:var(--faint); }
  @media print {
    body { background:#fff; padding:0; max-width:none; font-size:11pt; }
    @page { margin:18mm; }
    h2 { break-after:avoid; }
    tr { break-inside:avoid; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">CostGrid statement</div>
  <h1>${esc(headline)}</h1>
  <div class="who">${esc(options.company)} &middot; ${period}</div>
</header>

<section>
  <div class="grid">
    <div class="stat"><div class="label">Total</div><div class="value">${money(s.total)}</div></div>
    <div class="stat"><div class="label">Month before</div><div class="value">${money(s.previousTotal)}</div></div>
    ${s.projected !== undefined ? `<div class="stat"><div class="label">Projected month end</div><div class="value">${money(s.projected)}</div></div>` : ""}
    <div class="stat"><div class="label">Calls</div><div class="value">${s.calls.toLocaleString("en-US")}</div></div>
    <div class="stat"><div class="label">Input reused from cache</div><div class="value">${(s.cacheHitRatio * 100).toFixed(1)}%</div></div>
  </div>
  ${s.projected !== undefined ? '<p class="note">The projected figure is this month’s run rate carried to month end. It is a projection, not a measurement.</p>' : ""}
</section>

<section>
  <h2>Spend by team</h2>
  <table>
    <thead><tr><th>Team</th><th class="num">Spend</th><th class="num">Calls</th><th class="num">vs last month</th></tr></thead>
    <tbody>${rows(s.byDepartment)}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${money(s.total)}</td><td class="num">${s.calls.toLocaleString("en-US")}</td><td class="num">${delta(s.change)}</td></tr></tfoot>
  </table>
</section>

<section>
  <h2>Spend by service</h2>
  <table>
    <thead><tr><th>Service</th><th class="num">Spend</th><th class="num">Calls</th><th class="num">vs last month</th></tr></thead>
    <tbody>${rows(s.byAgent)}</tbody>
  </table>
</section>

<section>
  <h2>Spend by model</h2>
  <table>
    <thead><tr><th>Model</th><th class="num">Spend</th><th class="num">Calls</th><th class="num">vs last month</th></tr></thead>
    <tbody>${rows(s.byModel)}</tbody>
  </table>
</section>

${savingsBlock}
${jobsBlock}
${outcomeBlock}
${budgetBlock}

${
  caveats.length > 0
    ? `<section>
  <h2>What these figures rest on</h2>
  <ul class="note" style="list-style:disc;padding-left:32px;border-left:0">
    ${caveats.map((c) => `<li style="margin-bottom:6px">${c}</li>`).join("")}
  </ul>
</section>`
    : ""
}

<footer>
  Measured by CostGrid from the AI provider&rsquo;s own reported token counts, not estimated.
  Covers ${period} in UTC, the same period your provider invoices.
  Generated ${new Date(s.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.
</footer>
</body>
</html>`;
}
