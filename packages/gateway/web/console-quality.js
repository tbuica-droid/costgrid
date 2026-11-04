/**
 * "What a good answer looks like" on Settings, and "Why calls were changed"
 * on Limits.
 *
 * Per agent, the owner picks the answer format CostGrid checks (any, or JSON
 * with named fields) and the score a reported job needs to count as good.
 * Those two decide cost per good job on Results.
 */

import { call, state } from "./console-api.js";
import { isOwner } from "./console-outcomes.js";
import { button, escapeHtml, relativeTime } from "./ui.js";

function row(a, owner) {
  const disabled = owner ? "" : "disabled";
  return `<tr>
    <td><strong>${escapeHtml(a.name ?? a.agentId)}</strong>${a.name ? `<br /><span class="kpi-sub">${escapeHtml(a.agentId)}</span>` : ""}</td>
    <td colspan="3">
      <form class="quality-form form-row" data-agent="${escapeHtml(a.agentId)}" style="flex-wrap:wrap">
        <select name="format" aria-label="Answer format" ${disabled}>
          <option value="any" ${a.format === "any" ? "selected" : ""}>Any answer</option>
          <option value="json" ${a.format === "json" ? "selected" : ""}>JSON</option>
        </select>
        <input name="fields" placeholder="Required fields, comma separated" value="${escapeHtml(a.requiredFields.join(", "))}"
          aria-label="Required fields" style="min-width:240px" ${disabled} />
        <input name="bar" type="number" min="0" max="1" step="0.05" value="${a.bar}" aria-label="Quality bar"
          style="width:90px" ${disabled} />
        ${owner ? button("Save", 'type="submit"', "secondary") : ""}
      </form>
    </td>
  </tr>`;
}

/** The Settings card. `data` is GET /console/:t/quality, or null when it failed. */
export function qualityCard(data) {
  if (!data) return '<div class="banner bad" role="status"><strong>Quality settings couldn\'t be loaded.</strong></div>';
  if (data.agents.length === 0) {
    return '<div class="card"><p class="kpi-sub" style="margin:0">No agents yet. Name one in Setup and its settings appear here.</p></div>';
  }
  const owner = isOwner();
  return `<div class="card">
    <p class="kpi-sub" style="margin-top:0">CostGrid checks every answer it sees whole: not cut off, not refused and,
      if you choose JSON, valid and with the fields you name. A job counts as <strong>good</strong> when it finished and
      nothing says it fell short: a failed check, a person editing or rejecting it, or a score from your software below
      the bar (0 to 1). Only the result of each check is kept, never the answer.</p>
    <div class="scroll-x"><table>
      <thead><tr><th>Agent</th><th colspan="3">Answer format · required fields · quality bar</th></tr></thead>
      <tbody>${data.agents.map((a) => row(a, owner)).join("")}</tbody>
    </table></div>
  </div>`;
}

const KIND = {
  route: "Sent to another model",
  fallback: "Over budget, cheaper model",
  adjust: "Sent differently",
  kept: "Kept on its model",
  "not-routed": "Not moved",
};

/** The decision log section. `data` is GET /console/:t/decisions, or null. */
export function decisionsSection(data) {
  if (!data) return '<p class="kpi-sub">Could not load this just now.</p>';
  if (data.decisions.length === 0) {
    return `<p class="kpi-sub">Nothing yet. Each time a rule moves a call to another model, lowers its reasoning or adds
      caching (or would have, in a dry run), it is listed here with the reason.</p>`;
  }
  const rows = data.decisions
    .map(
      (d) => `<tr>
        <td>${relativeTime(d.decidedAt)}</td>
        <td>${escapeHtml(d.agentId)}</td>
        <td><span class="tag ${d.applied ? "on" : "monitor"}">${escapeHtml(KIND[d.kind] ?? d.kind)}${d.applied ? "" : " (dry run)"}</span></td>
        <td>${escapeHtml(d.requestedModel)}${d.chosenModel !== d.requestedModel ? ` → ${escapeHtml(d.chosenModel)}` : ""}</td>
        <td style="white-space:normal;min-width:260px">${escapeHtml(d.reason)}${
          d.rejected.length
            ? `<br /><span class="kpi-sub">Not chosen: ${d.rejected.map((r) => `${escapeHtml(r.model)} (${escapeHtml(r.why)})`).join("; ")}</span>`
            : ""
        }${
          d.predictedCostUsd !== null || d.predictedQuality !== null
            ? `<br /><span class="kpi-sub">Predicted ${d.predictedCostUsd !== null ? `$${escapeHtml(d.predictedCostUsd)} a call` : ""}${
                d.predictedQuality !== null ? `, quality ${escapeHtml(String(d.predictedQuality))}` : ""
              }${d.confidence !== null ? `, ${Math.round(d.confidence * 100)}% sure` : ""}</span>`
            : ""
        }</td>
      </tr>`,
    )
    .join("");
  return `<div class="card scroll-x"><table>
    <thead><tr><th>When</th><th>Agent</th><th>What</th><th>Model</th><th>Why</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

export async function submit(form) {
  if (!form.classList.contains("quality-form")) return false;
  const values = new FormData(form);
  const fields = String(values.get("fields") ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  await call("PUT", `/console/${state.tenantId}/quality/${encodeURIComponent(form.dataset.agent)}`, {
    format: values.get("format"),
    requiredFields: fields,
    bar: Number(values.get("bar")),
  });
  state.flash = { kind: "ok", text: "Saved. New answers are checked this way from the next call." };
  return true;
}

export async function click() {
  return false;
}
