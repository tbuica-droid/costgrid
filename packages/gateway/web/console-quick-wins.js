/**
 * Quick wins on the Limits screen: what lowering reasoning or adding caching
 * did to cost, before and after, on the owner's own traffic.
 *
 * The figures come from `/console/:tenant/quick-wins`. Nothing here computes a
 * number; it only lays out what the server measured.
 */

import { count, escapeHtml, money } from "./ui.js";

/** Rules that change how a call is sent, not whether it is allowed. */
export const ADJUSTS = new Set(["lower-reasoning", "add-cache"]);

const pct = (f) => `${f > 0 ? "+" : ""}${(f * 100).toFixed(0)}%`;
const perCall = (usd) => (usd === null ? null : `$${Number(usd).toFixed(5)}`);
const share = (f) => (f === null ? null : `${Math.round(f * 100)}%`);

const VERDICTS = {
  cheaper: '<span class="tag on">cheaper, measured</span>',
  "more-expensive": '<span class="tag off">more expensive, measured</span>',
  "fewer-jobs-finished": '<span class="tag off">fewer jobs finished</span>',
  "no-change": '<span class="tag monitor">no real difference</span>',
  "not-enough-data": '<span class="tag monitor">not enough data yet</span>',
};

function title(m) {
  return m.kind === "add-cache" ? "Caching the start of each request" : "Lower reasoning";
}

function scopeText(scope) {
  if (scope.kind === "tenant") return "everything";
  if (scope.kind === "department") return `team ${scope.department}`;
  return scope.agentId;
}

function card(m) {
  const line = (label, b, a) =>
    `<tr><td>${label}</td><td class="num">${b ?? "—"}</td><td class="num">${a ?? "—"}</td></tr>`;
  const jobs = m.jobs;
  const state =
    !m.enabled ? "switched off" : m.action === "monitor" ? "back to a dry run" : "changing calls";
  return `<div class="card" style="margin-bottom:12px">
    <p style="margin:0 0 8px">${VERDICTS[m.verdict] ?? ""} <strong>${escapeHtml(title(m))}</strong>
      <span class="kpi-sub">for ${escapeHtml(scopeText(m.scope))}, "${escapeHtml(m.policyName)}", ${state}</span></p>
    <div class="scroll-x"><table><thead><tr><th></th><th class="num">Before</th><th class="num">After</th></tr></thead><tbody>
      ${line("Calls", count(m.before.calls), count(m.after.calls))}
      ${line("Cost per call", perCall(m.before.costPerCallUsd), perCall(m.after.costPerCallUsd))}
      ${m.kind === "add-cache" ? line("Of which prompt and cache", perCall(m.before.inputCostPerCallUsd), perCall(m.after.inputCostPerCallUsd)) : ""}
      ${m.kind === "lower-reasoning" ? line("Answer tokens per call", m.before.outputTokensPerCall, m.after.outputTokensPerCall) : ""}
      ${jobs ? line("Jobs finished", share(jobs.before.finishedShare), share(jobs.after.finishedShare)) : ""}
      ${
        jobs
          ? line(
              "Cost per finished job",
              jobs.before.costPerFinishedJobUsd && money(jobs.before.costPerFinishedJobUsd),
              jobs.after.costPerFinishedJobUsd && money(jobs.after.costPerFinishedJobUsd),
            )
          : ""
      }
    </tbody></table></div>
    <p class="kpi-sub" style="margin-top:8px">${
      m.changePerCall === null ? "" : `Change per call: ${pct(m.changePerCall)}. `
    }${jobs && jobs.changePerFinishedJob !== null ? `Per finished job: ${pct(jobs.changePerFinishedJob)}. ` : ""}${escapeHtml(m.caveat)}</p>
  </div>`;
}

export function quickWinsSection(list) {
  if (list.length === 0) {
    return `<p class="kpi-sub">Nothing to measure yet. Add "Lower reasoning instead of refusing" or "Cache the
      unchanging start of each request" above, or take one from Advice. Once it changes calls, this compares
      cost per call and cost per finished job before and after.</p>`;
  }
  return list.map(card).join("");
}
