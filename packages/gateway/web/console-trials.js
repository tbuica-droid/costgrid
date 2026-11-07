/**
 * Trials: test a cheaper model on a small share of one agent's jobs, side by
 * side with the model it uses now, and switch only on evidence (v3, phase 5).
 */

import { call, flashBanner, state } from "./console-api.js";
import { isOwner } from "./console-outcomes.js";
import { button, escapeHtml, money, pageHead, relativeTime } from "./ui.js";

const STATUS = {
  running: '<span class="tag monitor">running</span>',
  passed: '<span class="tag on">passed: waiting for you</span>',
  applied: '<span class="tag on">switched</span>',
  failed: '<span class="tag off">did not pass</span>',
  stopped: '<span class="tag off">stopped</span>',
  reverted: '<span class="tag off">switched back</span>',
};

const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);

function trialCard(t) {
  const owner = isOwner();
  const line = (label, c, b) => `<tr><td>${label}</td><td class="num">${c}</td><td class="num">${b}</td></tr>`;
  return `<div class="card" style="margin-bottom:12px">
    <p style="margin:0 0 8px">${STATUS[t.status] ?? escapeHtml(t.status)} <strong>${escapeHtml(t.agentId)}</strong>:
      ${escapeHtml(t.candidateModel)} instead of ${escapeHtml(t.baselineModel)}, on ${t.shareMilli / 10}% of jobs
      <span class="kpi-sub">since ${relativeTime(t.startedAt)}</span></p>
    ${
      t.candidate
        ? `<div class="scroll-x"><table><thead><tr><th></th><th class="num">${escapeHtml(t.candidateModel)}</th><th class="num">${escapeHtml(t.baselineModel)}</th></tr></thead><tbody>
            ${line("Jobs", t.candidate.jobs, t.baseline.jobs)}
            ${line("Finished", pct(t.candidate.finishedShare), pct(t.baseline.finishedShare))}
            ${line("Up to standard", pct(t.candidate.qualityShare), pct(t.baseline.qualityShare))}
            ${line("Cost per good job", t.candidate.costPerGoodJobUsd ? money(t.candidate.costPerGoodJobUsd) : "—", t.baseline.costPerGoodJobUsd ? money(t.baseline.costPerGoodJobUsd) : "—")}
            ${t.grades.candidate + t.grades.baseline + t.grades.tie ? line("Grader preferred", t.grades.candidate, t.grades.baseline) : ""}
          </tbody></table></div>`
        : ""
    }
    <p class="kpi-sub" style="margin-top:8px">${escapeHtml(t.progress ?? t.why ?? "")}</p>
    ${owner && t.status === "running" ? button("Stop this trial", `type="button" data-action="trial-stop" data-id="${escapeHtml(t.id)}"`, "secondary") : ""}
    ${owner && t.status === "passed" ? button("Switch this agent", `type="button" data-action="trial-approve" data-id="${escapeHtml(t.id)}"`, "metal") : ""}
  </div>`;
}

function agentRow(a) {
  const owner = isOwner();
  const s = a.suggestion;
  return `<tr>
    <td><strong>${escapeHtml(a.name ?? a.id)}</strong><br /><span class="kpi-sub">on ${escapeHtml(a.current ?? "—")}</span></td>
    <td style="white-space:normal">${
      a.critical
        ? '<span class="tag warn">critical: never tested</span>'
        : s
          ? `Try <strong>${escapeHtml(s.model)}</strong>: predicted ${s.costPerFinishedJobUsd ? money(s.costPerFinishedJobUsd) : "?"} a finished job
             against ${s.currentCostPerFinishedJobUsd ? money(s.currentCostPerFinishedJobUsd) : "?"} now,
             ${Math.round(s.confidence * 100)}% sure. <span class="kpi-sub">${escapeHtml(s.prior)}</span>
             ${owner ? button("Test it on 5% of jobs", `type="button" data-action="trial-start" data-agent="${escapeHtml(a.id)}" data-model="${escapeHtml(s.model)}"`, "secondary") : ""}`
          : '<span class="kpi-sub">Nothing to test right now.</span>'
    }</td>
    <td>${
      owner
        ? `<label class="check"><input type="checkbox" data-action="trial-critical" data-agent="${escapeHtml(a.id)}" ${a.critical ? "checked" : ""} /> Critical</label>
           <label class="check"><input type="checkbox" data-action="trial-auto" data-agent="${escapeHtml(a.id)}" ${a.switching === "auto" ? "checked" : ""} ${a.canSwitchOnItsOwn ? "" : "disabled"} /> Switch on its own</label>`
        : ""
    }</td>
  </tr>`;
}

function spotChecks(list) {
  if (list.length === 0) return '<p class="kpi-sub">Nothing to check. Graded jobs appear here each week.</p>';
  return list
    .map(
      (s) => `<div class="card" style="margin-bottom:8px">
        <p style="margin:0">Job <code>${escapeHtml(s.runId)}</code> in trial ${escapeHtml(s.trialId)}, graded ${relativeTime(s.gradedAt)}.
          ${s.answersInMemory ? button("Read the two answers", `type="button" data-action="spot-read" data-id="${escapeHtml(s.callId)}"`, "secondary") : '<span class="kpi-sub">Look it up in your own records.</span>'}</p>
        <div id="spot-${escapeHtml(s.callId)}"></div>
        <p class="form-row" style="margin-top:8px">Which was better?
          ${["a", "b", "tie", "unsure"].map((v) => button(v === "a" ? "A" : v === "b" ? "B" : v === "tie" ? "Same" : "Can't tell", `type="button" data-action="spot-verdict" data-id="${escapeHtml(s.callId)}" data-verdict="${v}"`, "secondary")).join(" ")}</p>
      </div>`,
    )
    .join("");
}

export async function render() {
  const d = await call("GET", `/console/${state.tenantId}/trials`);
  const owner = isOwner();
  return `
    ${pageHead(
      "Trials",
      `Before CostGrid moves an agent to a cheaper model, it tests it on a small share of that agent's jobs, side by
      side with the model it uses now. A trial passes only if the work is as good, as many jobs finish, and a good job
      costs less. Work marked critical is never tested.`,
    )}
    ${flashBanner()}
    <h2>Agents</h2>
    <div class="card scroll-x"><table><thead><tr><th>Agent</th><th>What to test next</th><th>Settings</th></tr></thead>
      <tbody>${d.agents.map(agentRow).join("") || '<tr><td colspan="3" class="kpi-sub">No agent has sent calls through CostGrid in the last 30 days.</td></tr>'}</tbody></table></div>
    <h2 style="margin-top:26px">Trials</h2>
    ${d.trials.map(trialCard).join("") || '<p class="kpi-sub">No trials yet.</p>'}
    <h2 style="margin-top:26px">Grading</h2>
    <div class="card"><p style="margin-top:0">${
      d.grading.enabled
        ? `On, for ${d.grading.shareMilli / 10}% of trial jobs.`
        : "Off."
    } With grading on, a stronger model from a provider you already use compares the two models' answers on a small
      sample of trial jobs. It sees those requests, and its cost is counted in the agent's costs.</p>
      ${owner ? button(d.grading.enabled ? "Turn grading off" : "Turn grading on", `type="button" data-action="grading-toggle" data-on="${d.grading.enabled}"`, "secondary") : ""}</div>
    <h2 style="margin-top:26px">Spot checks</h2>
    <p class="section-note">Your verdict on a few graded jobs keeps the grader honest. You give yours first; the grader's
      stays hidden until you have.</p>
    ${spotChecks(d.spotChecks)}`;
}

export async function submit() {
  return false;
}

export async function click(target) {
  const t = state.tenantId;
  const a = target.dataset.action;
  if (a === "trial-start") {
    await call("POST", `/console/${t}/trials`, { agentId: target.dataset.agent, candidateModel: target.dataset.model, sharePct: 5 });
    state.flash = { kind: "ok", text: "Trial started on 5% of this agent's jobs. It is judged as the jobs come in." };
    return true;
  }
  if (a === "trial-stop" || a === "trial-approve") {
    await call("POST", `/console/${t}/trials/${encodeURIComponent(target.dataset.id)}/${a === "trial-stop" ? "stop" : "approve"}`);
    state.flash = {
      kind: "ok",
      text: a === "trial-stop" ? "Trial stopped." : "Switched. CostGrid keeps checking and switches back on its own if results get worse.",
    };
    return true;
  }
  if (a === "trial-critical" || a === "trial-auto") {
    const body = a === "trial-critical" ? { critical: target.checked } : { switching: target.checked ? "auto" : "suggest" };
    await call("PUT", `/console/${t}/agents/${encodeURIComponent(target.dataset.agent)}/trial-settings`, body);
    state.flash = { kind: "ok", text: "Saved." };
    return true;
  }
  if (a === "grading-toggle") {
    await call("PUT", `/console/${t}/grading`, { enabled: target.dataset.on !== "true", sharePct: 1.5 });
    state.flash = { kind: "ok", text: "Grading setting saved." };
    return true;
  }
  if (a === "spot-read") {
    const pair = await call("GET", `/console/${t}/spot-checks/${encodeURIComponent(target.dataset.id)}`);
    document.getElementById(`spot-${target.dataset.id}`).innerHTML = `<details open><summary class="kpi-sub">Request</summary><pre>${escapeHtml(pair.task)}</pre></details>
      <p><strong>A</strong></p><pre>${escapeHtml(pair.a)}</pre><p><strong>B</strong></p><pre>${escapeHtml(pair.b)}</pre>`;
    return "stay";
  }
  if (a === "spot-verdict") {
    await call("PUT", `/console/${t}/spot-checks/${encodeURIComponent(target.dataset.id)}`, { verdict: target.dataset.verdict });
    state.flash = { kind: "ok", text: "Thanks. Your verdict is kept beside the grader's." };
    return true;
  }
  return false;
}
