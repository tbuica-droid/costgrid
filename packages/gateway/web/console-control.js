/**
 * View and control on the Limits screen: pause or resume an agent's Claude
 * keys at the provider, hold an agent to a monthly cap, and see how long
 * each stop took.
 *
 * Every stop is described as taking time, because it does: a cap is checked
 * against the provider's usage report, which runs behind. Every string from
 * the server goes through escapeHtml.
 */

import { call, state } from "./console-api.js";
import { isOwner } from "./console-outcomes.js";
import { button, escapeHtml, money } from "./ui.js";

const KINDS = { key: "key", workspace: "workspace", project: "project", account: "account" };
const PROVIDER = { anthropic: "Claude", openai: "OpenAI" };

function duration(ms) {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${(m / 60).toFixed(1)} h`;
}

const when = (at) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const sourceName = (s) => `${escapeHtml(PROVIDER[s.provider] ?? s.provider)} ${KINDS[s.kind] ?? "source"} ${s.label ? `“${escapeHtml(s.label)}”` : `<code>${escapeHtml(s.id)}</code>`}`;

/** What is sent to Anthropic when a key is paused. Shown before anyone presses anything. */
const WHAT_IS_SENT = `<details class="control-sent"><summary>What CostGrid sends, and to whom</summary>
    <p class="kpi-sub">To pause or resume, CostGrid sends Anthropic the key's id and the new status (off or on),
      signed with your stored Claude admin key. To check a cap it uses the usage reports it already imports.
      Nothing else is sent: no prompts, no answers, no names, and nothing goes to CostGrid's makers.</p>
  </details>`;

function viewOnly() {
  return `<div class="card control-view">
      <p style="margin:0"><strong>Pause an agent's keys, and spending caps, are part of View and control.</strong></p>
      <p class="kpi-sub">It can turn off an agent's Claude keys at the provider with one click, pause them on its own
        when the agent reaches a monthly cap you set, alert you when it does, and show how long each stop took.
        It isn't on for this organisation. Pricing is on request at costgrid.dev.</p>
    </div>`;
}

function agentRow(a, { owner, canPause }) {
  const paused = a.paused.length > 0;
  const over = a.capUsd !== null && Number(a.spentUsd) >= Number(a.capUsd);
  const capLine = a.capUsd
    ? `Cap ${money(a.capUsd)} a month · ${money(a.spentUsd)} so far, by the provider's report`
    : `No cap · ${money(a.spentUsd)} this month, by the provider's report`;
  const actions = owner
    ? `<div class="form-row">
        ${
          paused
            ? button("Resume", `type="button" data-action="control-resume" data-agent-id="${escapeHtml(a.id)}"`, "sm")
            : a.pausable.length && canPause
              ? button("Pause now", `type="button" data-action="control-pause" data-agent-id="${escapeHtml(a.id)}" data-agent-name="${escapeHtml(a.name ?? a.id)}"`, "danger btn-sm")
              : ""
        }
      </div>
      <form id="cap-form-${escapeHtml(a.id)}" data-form="cap" data-agent-id="${escapeHtml(a.id)}" class="form-row end control-cap">
        <label class="field"><span class="field-label">Monthly cap, in dollars</span>
          <input name="monthlyUsd" type="text" inputmode="decimal" placeholder="500" value="${a.capUsd ? escapeHtml(a.capUsd) : ""}" /></label>
        ${button(a.capUsd ? "Change cap" : "Set cap", 'type="submit"', "sm")}
        ${a.capUsd ? button("Remove cap", `type="button" data-action="control-cap-clear" data-agent-id="${escapeHtml(a.id)}"`, "sm") : ""}
      </form>
      ${a.pausable.length ? "" : '<p class="kpi-sub">With no Claude keys to pause, a cap on this agent only alerts you.</p>'}`
    : "";
  const notPausable = a.notPausable.length
    ? `<p class="kpi-sub">Can't be paused from CostGrid: ${a.notPausable.map(sourceName).join(", ")}. OpenAI has no way to
        pause a key; set a project budget or delete the key in the OpenAI dashboard.</p>`
    : "";
  return `<article class="agent-card" aria-label="${escapeHtml(a.name ?? a.id)}">
      <div class="agent-card-head"><h4>${escapeHtml(a.name ?? a.id)}</h4>
        ${paused ? '<span class="tag block">Paused</span>' : ""}
        ${over ? '<span class="tag warn">Over its cap</span>' : ""}</div>
      <p class="kpi-sub">${capLine}</p>
      ${a.pausable.length ? `<p class="kpi-sub">Claude keys it uses: ${a.pausable.map(sourceName).join(", ")}</p>` : '<p class="kpi-sub">No Claude keys matched to it in Setup.</p>'}
      ${notPausable}
      ${actions}
    </article>`;
}

function historyTable(history) {
  if (!history.length) return "";
  return `<h3 class="control-history-head">Every pause and resume</h3>
    <div class="scroll-x"><table><thead><tr><th>When</th><th>Agent</th><th>Key</th><th>What</th>
      <th class="num">Report behind by</th><th class="num">Provider took</th></tr></thead>
    <tbody>${history
      .map(
        (h) => `<tr><td>${escapeHtml(when(h.requestedAt))}</td><td>${escapeHtml(h.agentId)}</td><td><code>${escapeHtml(h.keyId)}</code></td>
          <td>${h.action === "pause" ? (h.reason === "cap" ? "Paused by cap" : "Paused") : "Resumed"}${
            h.ok === false ? ` <span class="tag block">failed</span> <span class="kpi-sub">${escapeHtml(h.error ?? "")}</span>` : ""
          }</td>
          <td class="num">${duration(h.reportLagMs)}</td><td class="num">${duration(h.actionMs)}</td></tr>`,
      )
      .join("")}</tbody></table></div>
    <p class="kpi-sub">Measured stop time. A cap is checked against the provider's usage report, which runs behind
      (it comes in daily totals), so "report behind by" is how stale the newest figure was when the cap
      was seen. "Provider took" is from asking Anthropic to turn the key off until it said it had.</p>`;
}

/** Keys CostGrid paused that no agent card shows: the agent was removed, or the tier is View. Always resumable. */
function strandedSection(list, owner) {
  if (!list.length) return "";
  return `<div class="card control-stranded"><p style="margin:0"><strong>Keys CostGrid turned off</strong></p>
      ${list
        .map(
          (a) => `<div class="form-row"><span>${escapeHtml(a.name ?? a.id)}: ${a.paused.map((k) => `<code>${escapeHtml(k.keyId)}</code>`).join(", ")}</span>
            ${owner ? button("Resume", `type="button" data-action="control-resume" data-agent-id="${escapeHtml(a.id)}"`, "sm") : ""}</div>`,
        )
        .join("")}
    </div>`;
}

/** The section's markup. `d` is GET /console/:t/control. */
export function controlSection(d) {
  if (!d) return "";
  const owner = isOwner();
  const orphaned = Array.isArray(d.orphaned) ? d.orphaned : [];
  if (d.tier !== "control") {
    const stillOff = (Array.isArray(d.agents) ? d.agents : []).filter((a) => a.paused.length > 0);
    return `${viewOnly()}${strandedSection([...stillOff, ...orphaned], owner)}`;
  }
  const canPause = d.adminKeyConnected === true;
  const agents = Array.isArray(d.agents) ? d.agents : [];
  return `<p class="section-note">Turns an agent's Claude keys off at Anthropic, so every program using them stops,
      whether or not its traffic goes through CostGrid. Resume turns back on only the keys CostGrid turned off. A cap
      pauses the agent once a month when the provider's usage report shows it has spent that much; the report runs
      behind, so spending stops some time after the cap is crossed, not at once.</p>
    ${canPause ? "" : '<div class="banner" role="note"><strong>Connect a Claude admin key in Setup</strong> to pause keys or enforce caps.</div>'}
    ${WHAT_IS_SENT}
    ${strandedSection(orphaned, owner)}
    ${agents.length ? `<div class="agent-list">${agents.map((a) => agentRow(a, { owner, canPause })).join("")}</div>` : '<div class="empty">No agents yet. Name them in Setup, step 3.</div>'}
    ${historyTable(Array.isArray(d.history) ? d.history : [])}`;
}

function report(result, verb) {
  const parts = [];
  if (result.done.length) parts.push(`${result.done.length} ${result.done.length === 1 ? "key" : "keys"} ${verb}`);
  if (result.skipped.length) parts.push(`${result.skipped.length} already off, left alone`);
  if (result.failed.length) parts.push(`${result.failed.length} failed: ${result.failed.map((f) => f.error).join("; ")}`);
  return parts.join(". ") || "Nothing to change.";
}

export async function submit(form) {
  if (form.dataset.form !== "cap") return false;
  const raw = String(new FormData(form).get("monthlyUsd") ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  await call("PUT", `/console/${state.tenantId}/agents/${encodeURIComponent(form.dataset.agentId)}/cap`, { monthlyUsd: raw });
  state.flash = { kind: "ok", text: "Cap saved. If the agent has already spent that much this month, its Claude keys are paused now." };
  return true;
}

export async function click(target) {
  const { action, agentId, agentName } = target.dataset;
  const base = `/console/${state.tenantId}/agents/${encodeURIComponent(agentId ?? "")}`;
  if (action === "control-pause") {
    if (!window.confirm(`Turn off ${agentName}'s Claude keys at Anthropic? Everything using them stops until you resume.`)) return true;
    const result = await call("POST", `${base}/pause`);
    state.flash = { kind: result.failed.length ? "error" : "ok", text: report(result, "paused") };
    return true;
  }
  if (action === "control-resume") {
    const result = await call("POST", `${base}/resume`);
    state.flash = { kind: result.failed.length ? "error" : "ok", text: report(result, "turned back on") };
    return true;
  }
  if (action === "control-cap-clear") {
    await call("PUT", `${base}/cap`, { clear: true });
    state.flash = { kind: "ok", text: "Cap removed." };
    return true;
  }
  return false;
}
