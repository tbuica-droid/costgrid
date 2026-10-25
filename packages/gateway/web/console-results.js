/**
 * Results: what the money bought, what a run really costs, where reasoning
 * money goes, and the full monthly cost including what never reaches a
 * model provider's invoice.
 *
 * Measured figures and typed-in figures are never added together without
 * both parts being shown, and every estimate says it is one.
 */

import { call, flashBanner, formValues, state } from "./console-api.js";
import { isOwner, outcomesSection as jobsSection } from "./console-outcomes.js";
import { button, count, escapeHtml, field, money, pageHead } from "./ui.js";

const view = { days: 30 };

const fine = (usd) => (usd === null || usd === undefined ? "—" : `$${Number(usd).toFixed(Number(usd) < 1 ? 4 : 2)}`);

function outcomesSection(o) {
  if (o.reportedRuns === 0) {
    return `<div class="card"><p style="margin:0"><strong>No outcomes reported yet.</strong></p>
      <p class="kpi-sub" style="margin-top:8px">CostGrid sees tokens, not whether the answer was any good. One extra call
      from your software when a task finishes tells it, and then this shows cost per result that worked:
      <code>POST /v1/costgrid/outcome</code> with <code>{"run_id": "...", "success": true}</code>.
      ${o.totalRuns > 0 ? `${count(o.totalRuns)} runs in this window could be reported on.` : ""}</p></div>`;
  }
  const rate = o.succeeded / o.reportedRuns;
  return `<div class="grid cols-4">
    <div class="card"><div class="rail">Cost per success</div><div class="kpi-value">${fine(o.costPerSuccessUsd)}</div>
      <div class="kpi-sub">over ${count(o.succeeded)} runs that worked</div></div>
    <div class="card"><div class="rail">Worked</div><div class="kpi-value">${(rate * 100).toFixed(0)}%</div>
      <div class="kpi-sub">${count(o.succeeded)} of ${count(o.reportedRuns)} reported runs</div></div>
    <div class="card"><div class="rail">Spent on runs that failed</div><div class="kpi-value">${money(o.costOfFailureUsd)}</div>
      <div class="kpi-sub">${count(o.failed)} runs</div></div>
    <div class="card"><div class="rail">Reported on</div><div class="kpi-value">${count(o.reportedRuns)}</div>
      <div class="kpi-sub">of ${count(o.totalRuns)} runs. Unreported runs are not counted as either.</div></div>
  </div>`;
}

function spreadSection(rows) {
  if (rows.length === 0) {
    return `<p class="kpi-sub">No runs yet. Send <code>x-costgrid-run</code> with the same id on every call in one task
      and CostGrid can say what a typical run and a bad run cost.</p>`;
  }
  return `<div class="scroll-x"><table>
    <thead><tr><th>Agent</th><th class="num">Runs</th><th class="num">Typical (median)</th><th class="num">Bad (95th pct)</th>
      <th class="num">Worst</th><th class="num">Bad ÷ typical</th><th class="num">Steps, typical / bad</th></tr></thead>
    <tbody>${rows
      .map((r) => {
        const ratio = Number(r.medianUsd) > 0 ? Number(r.p95Usd) / Number(r.medianUsd) : null;
        return `<tr><td><strong>${escapeHtml(r.agentId)}</strong></td><td class="num">${count(r.runs)}</td>
          <td class="num">${fine(r.medianUsd)}</td><td class="num">${fine(r.p95Usd)}</td><td class="num">${fine(r.maxUsd)}</td>
          <td class="num">${ratio === null ? "—" : `${ratio.toFixed(1)}×`}</td>
          <td class="num">${count(r.medianSteps)} / ${count(r.p95Steps)}</td></tr>`;
      })
      .join("")}</tbody></table></div>
    <p class="kpi-sub" style="margin-top:8px">Research on agents finds the same task can cost many times more on one run
      than another, and models cannot predict which beforehand. A per-run limit set a little above the "bad" column
      stops the runaways without touching normal work.</p>`;
}

function reasoningSection(r) {
  const reported = r.byModel.filter((m) => m.reportedCalls > 0);
  const modelRows = reported
    .map((m) => {
      const share = Number(m.costUsd) > 0 ? Number(m.reasoningCostUsd) / Number(m.costUsd) : 0;
      return `<tr><td>${escapeHtml(m.model)}</td><td class="num">${count(m.reportedCalls)}</td>
        <td class="num">${count(m.reasoningTokens)}</td><td class="num">${money(m.reasoningCostUsd)}</td>
        <td class="num">${(share * 100).toFixed(0)}%</td></tr>`;
    })
    .join("");
  const requestRows = r.byRequest
    .map((q) => `<tr><td><code>${escapeHtml(q.requested)}</code></td><td class="num">${count(q.calls)}</td><td class="num">${money(q.costUsd)}</td></tr>`)
    .join("");
  return `
    ${
      modelRows
        ? `<div class="scroll-x"><table><thead><tr><th>Model</th><th class="num">Calls reporting it</th>
            <th class="num">Reasoning tokens</th><th class="num">Reasoning cost</th><th class="num">Share of spend</th></tr></thead>
            <tbody>${modelRows}</tbody></table></div>`
        : '<p class="kpi-sub">No calls in this window reported reasoning tokens.</p>'
    }
    <p class="kpi-sub" style="margin-top:8px">OpenAI reports reasoning tokens on each call, so this is exact for its
      models. Claude does not report thinking separately from output, so Claude calls are shown below by what they
      asked for rather than estimated.</p>
    ${requestRows ? `<div class="scroll-x" style="margin-top:12px"><table><thead><tr><th>Reasoning requested</th><th class="num">Calls</th><th class="num">Spend</th></tr></thead><tbody>${requestRows}</tbody></table></div>` : ""}
    ${
      r.overthinking.length
        ? `<div class="card" style="margin-top:12px"><p style="margin:0 0 6px"><strong>Thinking a lot to say a little</strong></p>
           ${r.overthinking.map((o) => `<p class="kpi-sub" style="margin:2px 0">${escapeHtml(o.agentId)}: ${count(o.calls)} short answers after long reasoning, ${money(o.reasoningCostUsd)} of reasoning.</p>`).join("")}
           <p class="kpi-sub" style="margin-top:6px">A signal, not a verdict. On simple tasks, extra reasoning tends to cost more without
             helping, so these are the first places to try a lower effort level.</p></div>`
        : ""
    }`;
}

function fullCostSection(f, costs, categories) {
  const rows = costs
    .map(
      (c) => `<tr><td><strong>${escapeHtml(c.label)}</strong><br /><span class="kpi-sub">${escapeHtml(categories[c.category])}</span></td>
        <td class="num">${money(c.monthlyAmountUsd)}</td><td>${escapeHtml(c.startsMonth)}${c.endsMonth ? ` to ${escapeHtml(c.endsMonth)}` : " onwards"}</td>
        <td class="num"><button type="button" class="btn btn-sm btn-danger" data-action="cost-remove"
          data-id="${escapeHtml(c.id)}">Remove</button></td></tr>`,
    )
    .join("");
  return `<div class="grid cols-4">
      <div class="card"><div class="rail">Metered AI spend</div><div class="kpi-value">${money(f.meteredUsd)}</div><div class="kpi-sub">measured, ${escapeHtml(f.month)}${f.partial ? " so far" : ""}</div></div>
      <div class="card"><div class="rail">Entered costs</div><div class="kpi-value">${money(f.enteredUsd)}</div><div class="kpi-sub">typed in, monthly</div></div>
      <div class="card"><div class="rail">Full cost</div><div class="kpi-value">${money(f.fullCostUsd)}</div><div class="kpi-sub">the two together</div></div>
      <div class="card"><div class="rail">Full cost per success</div><div class="kpi-value">${fine(f.fullCostPerSuccessUsd)}</div><div class="kpi-sub">needs reported outcomes</div></div>
    </div>
    ${rows ? `<div class="scroll-x" style="margin-top:12px"><table><thead><tr><th>Entered cost</th><th class="num">Per month</th><th>Applies</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    <form id="cost-form" class="card" style="margin-top:12px">
      ${field("What it is", "label", "text", 'placeholder="Support platform licence"')}
      <label class="field"><span class="field-label">Category</span>
        <select name="category">${Object.entries(categories).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join("")}</select></label>
      ${field("Per month, in dollars", "monthlyUsd", "text", 'placeholder="400"')}
      ${field("From month (YYYY-MM)", "startsMonth", "text", `value="${escapeHtml(f.month)}"`)}
      ${button("Add cost", 'type="submit"')}
      <p class="kpi-sub" style="margin-top:10px">Most of what AI costs a business is not on the model provider's invoice:
        licences, the platform it runs on, the people who review its work, training. Enter them here so the full cost,
        and the cost per result that worked, are real numbers.</p>
    </form>`;
}

export async function render() {
  // Two requests, so one failing still shows the other; each failure is a banner in its own section.
  const [res, jobs] = await Promise.allSettled([
    call("GET", `/console/${state.tenantId}/results?days=${view.days}`),
    call("GET", `/console/${state.tenantId}/outcomes?days=${view.days}`),
  ]);
  const failed = (r) => `<div class="banner bad" role="status"><strong>${escapeHtml(r.reason?.message ?? r.reason)}</strong></div>`;
  const d = res.value;
  const actions = `<form id="results-window" class="form-row">
      <select name="days" aria-label="Window">${[7, 30, 90].map((n) => `<option value="${n}" ${n === view.days ? "selected" : ""}>${n} days</option>`).join("")}</select>
      ${button("Show", 'type="submit"', "secondary")}
    </form>
    <a href="/console/${encodeURIComponent(state.tenantId)}/evidence" class="btn">Download this month's evidence pack</a>`;
  return `
    ${pageHead(
      "Results",
      `Whether the spending is worth it: cost per result that worked, what a typical and a bad
      run cost, where reasoning money goes, and the full monthly cost.`,
      actions,
    )}
    ${flashBanner()}
    <h2>Did the jobs get done?</h2>
    ${jobs.status === "fulfilled" ? jobsSection(jobs.value, { isOwner: isOwner() }) : failed(jobs)}
    ${res.status === "rejected" ? failed(res) : `<h2 style="margin-top:26px">Reported by your software</h2>
    ${outcomesSection(d.outcomes)}
    <h2 style="margin-top:26px">What a run costs</h2>
    ${spreadSection(d.runSpread)}
    <h2 style="margin-top:26px">Reasoning</h2>
    ${reasoningSection(d.reasoning)}
    <h2 style="margin-top:26px">Full cost this month</h2>
    ${fullCostSection(d.fullCost, d.fixedCosts, d.categories)}`}`;
}

export async function submit(form) {
  if (form.id === "results-window") {
    view.days = Number(formValues(form).days);
    return true;
  }
  if (form.id === "cost-form") {
    const v = formValues(form);
    await call("POST", `/console/${state.tenantId}/fixed-costs`, {
      label: v.label,
      category: v.category,
      monthlyUsd: String(v.monthlyUsd).trim().replace(/^\$/, "").replace(/,/g, ""),
      startsMonth: v.startsMonth,
    });
    state.flash = { kind: "ok", text: "Cost added. It is shown apart from metered spend, labelled as entered." };
    return true;
  }
  return false;
}

export async function click(target) {
  if (target.dataset.action === "cost-remove") {
    await call("DELETE", `/console/${state.tenantId}/fixed-costs/${target.dataset.id}`);
    state.flash = { kind: "ok", text: "Cost removed." };
    return true;
  }
  return false;
}
