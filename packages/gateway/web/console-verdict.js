/**
 * The plain-language top of each agent card on Results: one sentence that
 * says how the agent is doing, the cost per finished job, and the three
 * figures behind it (money on jobs that didn't finish, a typical job against
 * a bad one, and a person doing the same job).
 *
 * Every figure here is an estimate and says so. The person's cost is the
 * owner's own estimate and is labelled as theirs. Never "saves", never a
 * promise: a sentence says what the figures show and where to look.
 */

import { call, formValues, state } from "./console-api.js";
import { button, escapeHtml } from "./ui.js";

export const usd = (value) => `$${Number(value).toFixed(Number(value) < 0.1 ? 4 : 2)}`;
const has = (value) => value !== null && value !== undefined;

/** The month before this one, as YYYY-MM: the last one an owner can count in full. */
export function lastMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

export function monthName(month) {
  const [y, m] = String(month).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * The verdict, as one sentence of markup. `s` is the server's summary,
 * `spent` the dollars spent, `month` set for a count the owner entered.
 */
export function verdictSentence(s, { spent, person, month } = {}) {
  const cost = has(s.costPerFinishedUsd) ? escapeHtml(usd(s.costPerFinishedUsd)) : null;
  const when = month ? ` in ${escapeHtml(monthName(month))}, by your count` : "";
  const spentText = has(spent) && Number(spent) > 0 ? `${escapeHtml(usd(spent))} spent` : "Money spent";
  switch (s.verdict) {
    case "spend-no-successes":
      return month
        ? `${spentText} in ${escapeHtml(monthName(month))} and, by your count, no job finished. Worth checking before it
           spends more.`
        : `${spentText} and no job has finished yet. Worth checking before it spends more.`;
    case "too-early":
      return "Too early to say: its jobs are still in their waiting period.";
    case "no-data":
      return month
        ? `No spending reported for ${escapeHtml(monthName(month))} yet.`
        : "Nothing to judge yet.";
    case "dearer-than-person":
      return `About ${cost} per finished job${when}, more than the ${escapeHtml(usd(person.costPerJobUsd))} you estimated
        for a person doing it.`;
    case "mostly-failures":
      return `Most of the money (${escapeHtml(s.failureCostShare)}%) goes on jobs that don't finish. Why they fail is the
        first thing to look at.`;
    case "unpredictable":
      return `A bad job costs ${escapeHtml(s.spread.ratio)}× a typical one. A per-job limit a little above
        ${escapeHtml(usd(s.spread.badUsd))} would catch the runaways without touching normal work.`;
    default:
      return month
        ? `About ${cost} per finished job${when}.`
        : `About ${cost} per finished job, and the cost is steady from job to job.`;
  }
}

/** What the person comparison says; `ratio` is AI cost over a person's. */
function personLine(person, ratio) {
  const theirs = `your estimate: ${escapeHtml(String(person.minutes))} minutes at ${escapeHtml(usd(person.hourlyUsd))} an hour`;
  if (!has(ratio)) return `A person: about ${escapeHtml(usd(person.costPerJobUsd))} a job (${theirs}).`;
  const r = Number(ratio);
  const compared =
    r >= 1 ? `about ${escapeHtml(r.toFixed(1))}× a person's` : `about ${escapeHtml(String(Math.max(1, Math.round(r * 100))))}% of a person's`;
  return `The AI's cost per finished job is ${compared} ${escapeHtml(usd(person.costPerJobUsd))} (${theirs}).`;
}

function personForm(agent) {
  const p = agent.person;
  return `<details class="verdict-form"><summary>${p ? "Change the person estimate" : "Compare with a person"}</summary>
    <form id="person-cost-form-${escapeHtml(agent.id)}" data-form="person-cost" class="form-row end" data-agent-id="${escapeHtml(agent.id)}">
      <label class="field"><span class="field-label">Minutes a person takes per job</span>
        <input name="minutes" type="number" min="1" max="10080" step="1" required value="${p ? escapeHtml(String(p.minutes)) : ""}" /></label>
      <label class="field"><span class="field-label">Their hourly cost, in dollars</span>
        <input name="hourlyUsd" type="text" inputmode="decimal" required placeholder="35" value="${p ? escapeHtml(p.hourlyUsd) : ""}" /></label>
      ${button("Save", 'type="submit"', "sm")}
      ${p ? button("Remove", `type="button" data-action="person-cost-clear" data-agent-id="${escapeHtml(agent.id)}"`, "secondary") : ""}
    </form>
    <p class="kpi-sub">Include what the hour really costs you: pay, taxes and overheads. Your figure stays on this computer.</p>
  </details>`;
}

/**
 * The block at the top of a card. `agent` has `summary` and `person`;
 * `spent` and `month` as for verdictSentence. Owners get the person form.
 */
export function verdictBlock(agent, { owner = false, spent, month } = {}) {
  const s = agent.summary;
  if (!s) return "";
  const figures = [];
  if (has(s.costPerFinishedUsd)) {
    figures.push(["Cost per finished job", escapeHtml(usd(s.costPerFinishedUsd)), month ? "your count" : ""]);
  }
  if (has(s.failureCostShare)) figures.push(["On jobs that didn't finish", `${escapeHtml(s.failureCostShare)}%`, "of the spending"]);
  if (s.spread) {
    figures.push([
      "Typical job, bad job",
      `${escapeHtml(usd(s.spread.typicalUsd))} / ${escapeHtml(usd(s.spread.badUsd))}`,
      has(s.spread.ratio) ? `a bad one costs ${escapeHtml(s.spread.ratio)}×` : "",
    ]);
  }
  if (has(s.successRate) && month) figures.push(["Finished", `${escapeHtml(s.successRate)}%`, "of the jobs you counted"]);
  return `<div class="verdict${s.spendNoSuccesses ? " verdict-warn" : ""}">
      ${s.spendNoSuccesses ? '<p class="verdict-flag"><span class="tag warn">Spending, nothing finished</span></p>' : ""}
      <p class="verdict-sentence">${verdictSentence(s, { spent, person: agent.person, month })}
        <span class="kpi-sub">(indicative)</span></p>
      ${
        figures.length
          ? `<dl class="verdict-figures">${figures
              .map(([label, value, note]) => `<div><dt>${label}</dt><dd>${value}</dd>${note ? `<dd class="kpi-sub">${note}</dd>` : ""}</div>`)
              .join("")}</dl>`
          : ""
      }
      ${agent.person ? `<p class="kpi-sub verdict-person">${personLine(agent.person, s.personRatio)} AI model cost only; indicative.</p>` : ""}
      ${owner ? personForm(agent) : ""}
    </div>`;
}

/** For an agent known only from provider reports: the count form. */
export function countForm(agent, owner) {
  if (!owner) return "";
  const month = lastMonth();
  const current = (agent.counts ?? []).find((c) => c.month === month);
  return `<form id="job-count-form-${escapeHtml(agent.id)}" data-form="job-count" class="form-row end verdict-count" data-agent-id="${escapeHtml(agent.id)}">
      <input type="hidden" name="month" value="${escapeHtml(month)}" />
      <label class="field"><span class="field-label">Jobs finished in ${escapeHtml(monthName(month))}</span>
        <input name="finished" type="number" min="0" step="1" required value="${current ? escapeHtml(String(current.finished)) : ""}" /></label>
      <label class="field"><span class="field-label">Jobs that didn't finish (optional)</span>
        <input name="notFinished" type="number" min="0" step="1" value="${current && current.notFinished !== null ? escapeHtml(String(current.notFinished)) : ""}" /></label>
      ${button("Save count", 'type="submit"', "sm")}
    </form>`;
}

const whole = (value) => (String(value ?? "").trim() === "" ? null : Number(value));

export async function submit(form) {
  const agentId = form.dataset.agentId;
  if (form.dataset.form === "person-cost") {
    const v = formValues(form);
    await call("PUT", `/console/${state.tenantId}/agents/${encodeURIComponent(agentId)}/person-cost`, {
      minutes: whole(v.minutes),
      hourlyUsd: String(v.hourlyUsd).trim().replace(/^\$/, "").replace(/,/g, ""),
    });
    state.flash = { kind: "ok", text: "Saved. The comparison with a person uses your estimate and says so." };
    return true;
  }
  if (form.dataset.form === "job-count") {
    const v = formValues(form);
    await call("PUT", `/console/${state.tenantId}/agents/${encodeURIComponent(agentId)}/job-counts/${encodeURIComponent(v.month)}`, {
      finished: whole(v.finished),
      notFinished: whole(v.notFinished),
    });
    state.flash = { kind: "ok", text: "Count saved. The cost per finished job is now shown, labelled as from your count." };
    return true;
  }
  return false;
}

export async function click(target) {
  if (target.dataset.action !== "person-cost-clear") return false;
  await call("PUT", `/console/${state.tenantId}/agents/${encodeURIComponent(target.dataset.agentId)}/person-cost`, { clear: true });
  state.flash = { kind: "ok", text: "Person estimate removed." };
  return true;
}
