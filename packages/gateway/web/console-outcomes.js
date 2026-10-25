/**
 * "Did the jobs get done?": per agent, how many jobs finished, didn't finish,
 * were stopped by a limit, are still waiting, or can't be told, on the Results
 * screen.
 *
 * Two kinds of answer sit side by side and are never merged into one
 * unlabelled figure: what the owner's software reported, and what CostGrid
 * inferred from how the agent behaved. Every inferred figure says it is
 * indicative. Every string from the server goes through escapeHtml.
 */

import { call, state } from "./console-api.js";
import { button, count, escapeHtml } from "./ui.js";

/** Whether the person looking is an owner of the organisation on screen. */
export const isOwner = () => state.orgs.find((o) => o.tenantId === state.tenantId)?.role === "owner";

const REASONS = [
  ["handedOff", "Handed to a person"],
  ["askedAgain", "Asked again soon after"],
  ["error", "Something went wrong"],
  ["cutOff", "Answer was cut off"],
  ["declined", "The AI declined"],
  ["blocked", "Stopped by a limit you set"],
  ["reversed", "Finished, then asked again later"],
];

const EVIDENCE_TONE = { strong: "on", medium: "", weak: "warn" };

const HEADER_TIP = `Jobs CostGrid couldn't match can be matched exactly if your developer sends an
  <code>x-costgrid-task</code> header with the job's id, for example the ticket number.`;

const n = (value) => Number(value ?? 0);
const usd = (value) => `$${Number(value).toFixed(Number(value) < 0.1 ? 4 : 2)}`;
const plural = (k, one, many) => `${count(k)} ${k === 1 ? one : many}`;

/** One figure in the row of five; `note` is markup. */
function stat(label, value, note = "") {
  return `<div class="outcome-stat"><dt>${escapeHtml(label)}</dt><dd>${count(value)}</dd>
    ${note ? `<dd class="kpi-sub">${note}</dd>` : ""}</div>`;
}

/** Splits a finished or didn't-finish count into what was reported and what was inferred. */
function split(total, reported) {
  const told = Math.min(n(reported), total);
  if (told === 0) return total > 0 ? "inferred (indicative)" : "";
  const guessed = total - told;
  return `${count(told)} reported by your software${guessed > 0 ? `, ${count(guessed)} inferred (indicative)` : ""}`;
}

function countsRow(agent) {
  const c = agent.counts ?? {};
  const r = agent.reported ?? {};
  return `<dl class="outcome-counts">
      ${stat("Finished", n(c.finished), split(n(c.finished), r.finished))}
      ${stat("Didn't finish", n(c.failed), split(n(c.failed), r.failed))}
      ${stat("Stopped by your limits", n(c.abandoned))}
      ${stat("Still waiting", n(c.waiting), n(c.waiting) > 0 ? "too soon to say" : "")}
      ${stat("Can't tell", n(c.unknown), n(c.unknown) > 0 ? "no way to match the job" : "")}
    </dl>`;
}

function reasonsList(agent) {
  const r = agent.reasons ?? {};
  const rows = REASONS.filter(([key]) => n(r[key]) > 0).sort((a, b) => n(r[b[0]]) - n(r[a[0]]));
  if (rows.length === 0) return "";
  return `<p class="outcome-label">What CostGrid noticed</p>
    <ul class="outcome-reasons">${rows
      .map(([key, label]) => `<li><span>${escapeHtml(label)}</span><span class="num">${count(n(r[key]))}</span></li>`)
      .join("")}</ul>`;
}

function costLines(agent) {
  const lines = [];
  if (agent.costPerFinishedUsd !== null && agent.costPerFinishedUsd !== undefined) {
    lines.push(`About ${escapeHtml(usd(agent.costPerFinishedUsd))} per finished job (indicative)`);
  }
  if (agent.failureCostShare !== null && agent.failureCostShare !== undefined) {
    // Jobs still waiting are left out of this share, so the sentence says so.
    lines.push(
      `Of the spending on jobs with an outcome so far, ${escapeHtml(agent.failureCostShare)}% went on jobs that didn't finish (indicative)`,
    );
  }
  if (agent.totalCostUsd !== null && agent.totalCostUsd !== undefined) {
    lines.push(`${escapeHtml(usd(agent.totalCostUsd))} spent on these jobs through CostGrid`);
  }
  return lines.length ? `<div class="agent-costs">${lines.map((l) => `<p>${l}</p>`).join("")}</div>` : "";
}

function upgradeLine(agent, owner) {
  if (!agent.needsUpgrade) return "";
  const sentence = `<p class="kpi-sub">This agent's purpose was set before CostGrid could tell on its own whether a job
    finished, so only what your software reports is counted.${owner ? "" : " An owner of this organisation can turn on automatic detection."}</p>`;
  const action =
    owner && agent.purposeId
      ? `<div class="form-row">${button(
          "Turn on automatic detection",
          `type="button" data-action="outcomes-upgrade" data-agent-id="${escapeHtml(agent.id)}"
            data-purpose-id="${escapeHtml(agent.purposeId)}" data-agent-name="${escapeHtml(agent.name ?? agent.id)}"`,
          "sm",
        )}</div>`
      : "";
  return `<div class="outcome-note">${sentence}${action}</div>`;
}

function matchingNotes(agent) {
  const parts = [];
  const tools = Array.isArray(agent.escalationTools) ? agent.escalationTools : [];
  if (tools.length) {
    parts.push(`<p class="kpi-sub">Hand-off tools we matched: ${tools.map((t) => `<code>${escapeHtml(t)}</code>`).join(", ")}</p>`);
  }
  const unmatched = n(agent.identity?.none);
  const shared = n(agent.sharedOpenings);
  if (unmatched > 0 || shared > 0) {
    const what = [
      unmatched > 0 ? `${plural(unmatched, "job", "jobs")} couldn't be matched to earlier ones` : "",
      shared > 0 ? `${plural(shared, "job", "jobs")} opened with a message too common to match` : "",
    ]
      .filter(Boolean)
      .join("; ");
    parts.push(`<p class="kpi-sub">${what}. ${HEADER_TIP}</p>`);
  }
  return parts.join("");
}

function agentCard(agent, index, owner) {
  const evidence = String(agent.evidence ?? "weak");
  const tone = EVIDENCE_TONE[evidence] ?? "warn";
  const preset = agent.presetLabel ? `<span class="kpi-sub">${escapeHtml(agent.presetLabel)}</span>` : "";
  return `<article class="agent-card" aria-labelledby="outcome-agent-${index}">
      <div class="agent-card-head">
        <h4 id="outcome-agent-${index}">${escapeHtml(agent.name ?? agent.id)}</h4>
        ${preset}
        <span class="tag ${tone}">Evidence: ${escapeHtml(evidence)}</span>
      </div>
      ${agent.mostlyInferred ? '<p class="outcome-badge"><span class="tag">Inferred from how the agent behaved (indicative)</span></p>' : ""}
      ${countsRow(agent)}
      ${costLines(agent)}
      ${reasonsList(agent)}
      ${matchingNotes(agent)}
      ${upgradeLine(agent, owner)}
    </article>`;
}

function noDataCard(list) {
  if (!list.length) return "";
  return `<div class="card sunk outcome-nodata">
      <p><strong>No outcome data yet:</strong> these agents' costs come from provider reports, which don't say whether
        a job finished. Send their traffic through CostGrid (Advanced setup) to see this.</p>
      <ul>${list.map((a) => `<li>${escapeHtml(a.name ?? a.id)}</li>`).join("")}</ul>
    </div>`;
}

function topNotes(payload) {
  const notes = [];
  const fp = payload.fingerprint ?? {};
  if (fp.available === false) {
    notes.push(`<strong>Matching repeat jobs isn't available on this install.</strong> Jobs can only be matched when your
      software sends the <code>x-costgrid-task</code> header.`);
  } else if (fp.enabled === false) {
    notes.push(`<strong>Matching repeat jobs is off.</strong> CostGrid still spots hand-offs and errors, but can't tell
      when a job finished unless your software sends the <code>x-costgrid-task</code> header. You can turn it on in
      <a href="#settings" data-page="settings">Settings</a>.`);
  }
  if (payload.retentionNote) {
    notes.push(`<strong>Some reversals can't be seen.</strong> Call records are kept for less time than the waiting
      period for some agents, so a job that finished and was asked again later may still count as finished. You can
      change how long records are kept in <a href="#settings" data-page="settings">Settings</a>.`);
  }
  return notes.map((note) => `<div class="banner" role="note">${note}</div>`).join("");
}

/** The section's markup. `payload` is GET /console/:t/outcomes. */
export function outcomesSection(payload, { isOwner: owner = false } = {}) {
  const agents = Array.isArray(payload?.agents) ? payload.agents : [];
  const noData = Array.isArray(payload?.noOutcomeData) ? payload.noOutcomeData : [];
  const intro = `<p class="section-note">CostGrid estimates which jobs finished from how each agent behaved: asked again
    soon after, handed to a person, or ended in an error. These are estimates; a one-line report from your software
    makes them exact.</p>`;
  if (agents.length === 0 && noData.length === 0) {
    return `${intro}<div class="empty">Nothing to show yet. This appears once your agents send requests through
      CostGrid (Advanced setup), so it can see how each job went.</div>`;
  }
  return `${intro}${topNotes(payload)}
    ${agents.length ? `<div class="agent-list">${agents.map((a, i) => agentCard(a, i, owner)).join("")}</div>` : ""}
    ${noDataCard(noData)}`;
}

export async function submit() {
  return false;
}

export async function click(target) {
  if (target.dataset.action !== "outcomes-upgrade") return false;
  const { agentId, purposeId, agentName } = target.dataset;
  await call("PATCH", `/console/${state.tenantId}/agents/${encodeURIComponent(agentId)}`, { purposeId });
  state.flash = { kind: "ok", text: `Automatic detection is on for ${agentName || agentId}.` };
  return true;
}
