/**
 * What changed: what your agents started doing that they never did before,
 * including tools the model invented and was never given.
 *
 * CostGrid can tell you what is unusual. It cannot tell you what is wrong,
 * and the page says so at the bottom whether or not it found anything.
 */

import { call, flashBanner, formValues, state } from "./console-api.js";
import { button, count, escapeHtml, pageHead, relativeTime } from "./ui.js";

const view = { days: 7 };

function signalCard(s) {
  const invented = s.kind === "invented-tool";
  return `<div class="card" style="margin-bottom:12px">
    <h3>${escapeHtml(s.headline)}</h3>
    <p style="margin:0 0 8px">${escapeHtml(s.evidence)}</p>
    <p class="kpi-sub">${count(s.occurrences)} time${s.occurrences === 1 ? "" : "s"}, first seen ${relativeTime(s.firstSeenAt)}.</p>
    ${
      invented
        ? `<div style="margin-top:10px">${button(
            "Stop offering this tool, as a dry run",
            `type="button" data-action="drift-deny" data-agent="${escapeHtml(s.agentId)}" data-tool="${escapeHtml(s.subject)}"`,
          )}
           <span class="kpi-sub" style="margin-left:10px">Records what it would have stopped and
             changes nothing until you enforce it.</span></div>`
        : ""
    }
  </div>`;
}

export async function render() {
  const report = await call("GET", `/console/${state.tenantId}/drift?days=${view.days}`);
  const invented = report.signals.filter((s) => s.kind === "invented-tool");
  const rest = report.signals.filter((s) => s.kind !== "invented-tool");

  let body;
  if (report.signals.length === 0) {
    body = `<div class="card"><p style="margin:0"><strong>${
      report.established
        ? "Nothing new. Every agent did what it has done before."
        : "Nothing new, and not enough history yet to be sure."
    }</strong></p>${
      report.established
        ? ""
        : `<p class="kpi-sub" style="margin-top:8px">${count(report.baselineCalls)} calls before this
            window; 500 are needed before "never done this before" means anything. Invented tool
            calls are still reported.</p>`
    }</div>`;
  } else {
    body =
      (invented.length ? `<h2>The model invented something</h2>${invented.map(signalCard).join("")}` : "") +
      (rest.length ? `<h2 style="margin-top:22px">New, which usually means a deploy</h2>${rest.map(signalCard).join("")}` : "") +
      (report.established
        ? ""
        : `<p class="kpi-sub">Only invented tool calls are shown: there is not yet enough history for
             the rest, which needs 500 calls before this window.</p>`);
  }

  return `
    ${pageHead(
      "What changed",
      `What your agents started doing that they never did before, compared
      against the 30 days before the window. Nothing here reads content: it is names, counts and
      who handed work to whom.`,
      `<form id="drift-window" class="form-row">
        <select name="days" aria-label="Window">
          ${[1, 7, 30].map((d) => `<option value="${d}" ${d === view.days ? "selected" : ""}>${d} day${d === 1 ? "" : "s"}</option>`).join("")}
        </select>
        ${button("Show", 'type="submit"', "secondary")}
      </form>`,
    )}
    ${flashBanner()}
    ${body}
    <p class="section-note" style="margin-top:22px">CostGrid can tell you what is unusual. It cannot
      tell you what is wrong. Most new behaviour is a release.</p>`;
}

export async function submit(form) {
  if (form.id !== "drift-window") return false;
  view.days = Number(formValues(form).days);
  return true;
}

export async function click(target) {
  if (target.dataset.action !== "drift-deny") return false;
  await call("POST", `/console/${state.tenantId}/drift/deny`, {
    agentId: target.dataset.agent,
    tool: target.dataset.tool,
  });
  state.flash = {
    kind: "ok",
    text: `${target.dataset.agent} will no longer be offered ${target.dataset.tool}, as a dry run. Enforce it from the dashboard when you are sure.`,
  };
  return true;
}
