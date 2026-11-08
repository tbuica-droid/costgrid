/**
 * Tests (trials in the code): try a cheaper model on a small share of one
 * agent's jobs, side by side with the model it uses now, and switch only on
 * evidence (v3, phases 5 and 6).
 */

import { call, flashBanner, state } from "./console-api.js";
import { isOwner } from "./console-outcomes.js";
import { button, escapeHtml, pageHead, relativeTime } from "./ui.js";

/** Per-job costs are often under a cent, so show four decimals below a dollar. */
const money = (usd) => {
  const n = Number(usd);
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
};

const STATUS = {
  running: '<span class="tag monitor">testing</span>',
  passed: '<span class="tag on">passed: ready to switch</span>',
  applied: '<span class="tag on">switched</span>',
  failed: '<span class="tag off">didn\'t pass</span>',
  stopped: '<span class="tag off">stopped</span>',
  reverted: '<span class="tag off">switched back</span>',
};

const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);

/** Agent names by id, for headings; filled on each render. */
let names = {};

function trialCard(t) {
  const owner = isOwner();
  const line = (label, c, b) => `<tr><td>${label}</td><td class="num">${c}</td><td class="num">${b}</td></tr>`;
  return `<div class="card" style="margin-bottom:12px">
    <p style="margin:0 0 8px">${STATUS[t.status] ?? escapeHtml(t.status)} <strong>${escapeHtml(names[t.agentId] ?? t.agentId)}</strong>:
      trying ${escapeHtml(t.candidateModel)} instead of ${escapeHtml(t.baselineModel)} on ${t.shareMilli / 10}% of jobs
      <span class="kpi-sub">since ${relativeTime(t.startedAt)}</span></p>
    ${
      t.candidate
        ? `<div class="scroll-x"><table><thead><tr><th></th><th class="num">${escapeHtml(t.candidateModel)}</th><th class="num">${escapeHtml(t.baselineModel)}</th></tr></thead><tbody>
            ${line("Jobs", t.candidate.jobs, t.baseline.jobs)}
            ${line("Got done", pct(t.candidate.finishedShare), pct(t.baseline.finishedShare))}
            ${line("Good enough", pct(t.candidate.qualityShare), pct(t.baseline.qualityShare))}
            ${line("Cost per good job", t.candidate.costPerGoodJobUsd ? money(t.candidate.costPerGoodJobUsd) : "—", t.baseline.costPerGoodJobUsd ? money(t.baseline.costPerGoodJobUsd) : "—")}
            ${t.grades.candidate + t.grades.baseline + t.grades.tie ? line("AI judge preferred", t.grades.candidate, t.grades.baseline) : ""}
          </tbody></table></div>`
        : ""
    }
    <p class="kpi-sub" style="margin-top:8px">${escapeHtml(t.progress ?? t.why ?? "")}</p>
    ${owner && t.status === "running" ? button("Stop this test", `type="button" data-action="trial-stop" data-id="${escapeHtml(t.id)}"`, "secondary") : ""}
    ${owner && t.status === "passed" ? button("Switch this agent", `type="button" data-action="trial-approve" data-id="${escapeHtml(t.id)}"`) : ""}
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
          ? `Try <strong>${escapeHtml(s.model)}</strong>: about ${s.costPerFinishedJobUsd ? money(s.costPerFinishedJobUsd) : "?"} a finished job,
             against ${s.currentCostPerFinishedJobUsd ? money(s.currentCostPerFinishedJobUsd) : "?"} now. We're ${Math.round(s.confidence * 100)}% sure,
             so a test will tell. <span class="kpi-sub">Based on: ${escapeHtml(s.prior)}</span>
             ${owner ? button("Test it on 5% of jobs", `type="button" data-action="trial-start" data-agent="${escapeHtml(a.id)}" data-model="${escapeHtml(s.model)}"`, "secondary") : ""}`
          : '<span class="kpi-sub">Nothing worth testing right now.</span>'
    }</td>
    <td>${
      owner
        ? `<label class="check"><input type="checkbox" data-action="trial-critical" data-agent="${escapeHtml(a.id)}" ${a.critical ? "checked" : ""} /> Critical: never test</label>
           <label class="check"><input type="checkbox" data-action="trial-auto" data-agent="${escapeHtml(a.id)}" ${a.switching === "auto" ? "checked" : ""} ${a.canSwitchOnItsOwn ? "" : "disabled"} /> Switch on its own</label>
           <label class="check"><input type="checkbox" data-action="routing-per-request" data-agent="${escapeHtml(a.id)}" ${a.perRequest ? "checked" : ""} ${a.canSwitchOnItsOwn ? "" : "disabled"} /> Pick the best model for each request</label>
           <form class="step-up-form form-row" data-agent="${escapeHtml(a.id)}" style="margin-top:6px">
             <input name="model" placeholder="Cheaper model to try first" value="${escapeHtml(a.stepUpModel ?? "")}" style="width:200px" aria-label="Cheaper model to try first" />
             ${button("Save", 'type="submit"', "secondary")}
           </form>`
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

function ranking(r) {
  if (!r) return "";
  const rows = r.models
    .map(
      (m) => `<tr${m.current ? ' style="font-weight:600"' : ""}>
        <td>${escapeHtml(m.model)}${m.current ? " (now)" : ""}<br /><span class="kpi-sub">${escapeHtml(m.note)}</span></td>
        <td class="num">${pct(m.quality.mean)}<br /><span class="kpi-sub">${pct(m.quality.low)} to ${pct(m.quality.high)}</span></td>
        <td class="num">${pct(m.finish.mean)}</td>
        <td class="num">${m.costPerFinishedJobUsd ? money(m.costPerFinishedJobUsd) : "—"}<br /><span class="kpi-sub">${m.costBasis}</span></td>
        <td class="num">${pct(m.confidence)}</td>
        <td style="white-space:normal"><span class="kpi-sub">${m.evidence.judged} judged of ${m.evidence.calls} calls; ${escapeHtml(m.prior)}</span></td>
      </tr>`,
    )
    .join("");
  return `<div class="card scroll-x" style="margin-top:10px"><p class="kpi-sub" style="margin-top:0">For ${escapeHtml(r.agent)}${r.kind ? `, a ${escapeHtml(r.kind)} task` : ""}. Best first, for "same quality, lower cost".</p>
    <table><thead><tr><th>Model</th><th class="num">Good enough</th><th class="num">Gets done</th><th class="num">Per finished job</th><th class="num">How sure</th><th>Based on</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function selfChecks(s) {
  if (!s) return "";
  const g = s.grader;
  return `<div class="card"><p style="margin-top:0">${
    s.checks.length
      ? `${s.checks.filter((c) => c.within === 1).length} of ${s.checks.filter((c) => c.within !== null).length} recent predictions fell inside their range.
         Where they did not, CostGrid trusts its predictions less and is slower to suggest a switch.`
      : "Predictions are checked against what happened a week after they are made. No check has come due yet."
  }</p>
  <p class="kpi-sub">${
    g.checked
      ? `The AI judge agreed with you ${g.agreed} of ${g.checked} times.${g.trusted ? "" : " That's too seldom, so its verdicts no longer count in tests."}`
      : "Once you've done a few spot checks, the AI judge is checked against you."
  }</p></div>`;
}

export async function render() {
  const [d, checks] = await Promise.all([
    call("GET", `/console/${state.tenantId}/trials`),
    call("GET", `/console/${state.tenantId}/self-checks`).catch(() => null),
  ]);
  const owner = isOwner();
  names = Object.fromEntries(d.agents.map((a) => [a.id, a.name ?? a.id]));
  return `
    ${pageHead(
      "Tests",
      `Before CostGrid moves an agent to a cheaper model, it tries that model on a few of the agent's jobs, side by
      side with the one it uses now. It only suggests the switch if the work is just as good, just as many jobs get
      done, and each good job costs less. Work you mark as critical is never tested.`,
    )}
    ${flashBanner()}
    <h2>Your agents</h2>
    <div class="card scroll-x"><table><thead><tr><th>Agent</th><th>What to try next</th><th>Settings</th></tr></thead>
      <tbody>${d.agents.map(agentRow).join("") || '<tr><td colspan="3" class="kpi-sub">No agent has sent calls through CostGrid in the last 30 days.</td></tr>'}</tbody></table></div>
    <h2 style="margin-top:26px">Which model is best?</h2>
    <form id="which-model-form" class="card">
      <p class="kpi-sub" style="margin-top:0">Pick an agent, and paste a sample request if you like. The sample is read to
        tell what kind of task it is, and not kept.</p>
      <select name="agentId" aria-label="Agent">${d.agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name ?? a.id)}</option>`).join("")}</select>
      <textarea name="sample" rows="3" placeholder="Optional: a sample request" style="width:100%;margin-top:8px"></textarea>
      ${button("Rank the models", 'type="submit"', "secondary")}
      <div id="which-model-result">${ranking(view.ranking)}</div>
    </form>
    <h2 style="margin-top:26px">Tests so far</h2>
    ${d.trials.map(trialCard).join("") || '<p class="kpi-sub">No tests yet. Start one from your agents above.</p>'}
    <h2 style="margin-top:26px">AI judge</h2>
    <div class="card"><p style="margin-top:0">${
      d.grading.enabled
        ? `On, for ${d.grading.shareMilli / 10}% of test jobs.`
        : "Off."
    } With it on, a stronger AI you already use compares the two models' answers on a small sample of test jobs.
      It sees those requests, and what it costs is added to the agent's costs.</p>
      ${owner ? button(d.grading.enabled ? "Turn the AI judge off" : "Turn the AI judge on", `type="button" data-action="grading-toggle" data-on="${d.grading.enabled}"`, "secondary") : ""}</div>
    <h2 style="margin-top:26px">Spot checks</h2>
    <p class="section-note">Your own verdict on a few judged jobs keeps the AI judge honest. You give yours first; the
      judge's stays hidden until you have. While spot checks are on, the two answers the grader compared are held in this app's
      memory, never on disk, so you can read them: at most 50, for 24 hours or until the app restarts. Turning spot
      checks off forgets them at once.</p>
    ${owner ? `<p>${button(d.grading.spotChecks ? "Turn spot checks off" : "Turn spot checks on", `type="button" data-action="spot-toggle" data-on="${d.grading.spotChecks}"`, "secondary")}</p>` : ""}
    ${d.grading.spotChecks ? spotChecks(d.spotChecks) : ""}
    <h2 style="margin-top:26px">How CostGrid checks itself</h2>
    ${selfChecks(checks)}`;
}

const view = { ranking: null };

export async function submit(form) {
  const t = state.tenantId;
  if (form.id === "which-model-form") {
    const v = Object.fromEntries(new FormData(form).entries());
    view.ranking = await call("POST", `/console/${t}/which-model`, { agentId: v.agentId, ...(v.sample ? { sample: v.sample } : {}) });
    return true;
  }
  if (form.classList.contains("step-up-form")) {
    const model = String(new FormData(form).get("model") ?? "").trim();
    await call("PUT", `/console/${t}/agents/${encodeURIComponent(form.dataset.agent)}/routing`, { stepUpModel: model === "" ? null : model });
    state.flash = { kind: "ok", text: model === "" ? "Cheap-first is off." : `Buffered requests now try ${model} first, and step up only if its answer clearly fails.` };
    return true;
  }
  return false;
}

export async function click(target) {
  const t = state.tenantId;
  const a = target.dataset.action;
  if (a === "trial-start") {
    await call("POST", `/console/${t}/trials`, { agentId: target.dataset.agent, candidateModel: target.dataset.model, sharePct: 5 });
    state.flash = { kind: "ok", text: "Test started on 5% of this agent's jobs. You'll see how it does as the jobs come in." };
    return true;
  }
  if (a === "trial-stop" || a === "trial-approve") {
    await call("POST", `/console/${t}/trials/${encodeURIComponent(target.dataset.id)}/${a === "trial-stop" ? "stop" : "approve"}`);
    state.flash = {
      kind: "ok",
      text: a === "trial-stop" ? "Test stopped." : "Switched. CostGrid keeps an eye on it and switches back on its own if results get worse.",
    };
    return true;
  }
  if (a === "trial-critical" || a === "trial-auto") {
    const body = a === "trial-critical" ? { critical: target.checked } : { switching: target.checked ? "auto" : "suggest" };
    await call("PUT", `/console/${t}/agents/${encodeURIComponent(target.dataset.agent)}/trial-settings`, body);
    state.flash = { kind: "ok", text: "Saved." };
    return true;
  }
  if (a === "routing-per-request") {
    await call("PUT", `/console/${t}/agents/${encodeURIComponent(target.dataset.agent)}/routing`, { perRequest: target.checked });
    state.flash = { kind: "ok", text: target.checked ? "This agent now gets the model its own evidence chose for each kind of task." : "Per-request routing is off." };
    return true;
  }
  if (a === "spot-toggle") {
    await call("PUT", `/console/${t}/spot-checks`, { enabled: target.dataset.on !== "true" });
    state.flash = { kind: "ok", text: target.dataset.on === "true" ? "Spot checks are off; any answers held in memory are gone." : "Spot checks are on." };
    return true;
  }
  if (a === "grading-toggle") {
    await call("PUT", `/console/${t}/grading`, { enabled: target.dataset.on !== "true", sharePct: 1.5 });
    state.flash = { kind: "ok", text: "Saved." };
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
