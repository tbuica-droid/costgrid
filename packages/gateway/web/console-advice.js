/**
 * Advice and autopilot: what CostGrid would propose from your own traffic,
 * and how much of that it may do by itself.
 *
 * The rules are the same as on the command line. A proposal is installed as
 * a dry run and nothing else. Autopilot cannot refuse a call or set a budget
 * at any level, and everything it does undoes in one click.
 */

import { call, flashBanner, formValues, state } from "./console-api.js";
import { button, count, escapeHtml, field, money, relativeTime } from "./ui.js";

const view = { days: 30, proposals: [], lastRun: null };

const HEADINGS = {
  saving: "Saves money now",
  guardrail: "Bounds a risk, saves nothing today",
  finding: "Worth knowing, nothing to install",
};

function backtestLine(b, intent) {
  if (!b) return "";
  if (b.callsAffected === 0) {
    return intent === "guardrail"
      ? "Replayed: would not have fired once over this window. It sits above everything you actually did, which is how a guardrail should be set."
      : "Replayed over this window: would never have fired.";
  }
  const verb = b.basis === "estimated" ? "would have saved about" : "would not have spent";
  const amount = b.amountUsd === null ? "an amount it could not price" : money(b.amountUsd);
  return (
    `Replayed: ${count(b.callsAffected)} of ${count(b.callsInScope)} calls, ${verb} ${amount}.` +
    (b.unpriceable > 0 ? ` ${count(b.unpriceable)} calls could not be priced and are excluded.` : "") +
    ` ${b.caveat}`
  );
}

function proposalCard(p, index) {
  return `<div class="card" style="margin-bottom:12px">
    <h3 style="margin:0 0 6px;font-size:16px">${escapeHtml(p.headline)}</h3>
    <p style="margin:0 0 8px">${escapeHtml(p.evidence)}</p>
    ${p.backtest ? `<p class="kpi-sub" style="margin-bottom:10px">${escapeHtml(backtestLine(p.backtest, p.intent))}</p>` : ""}
    ${
      p.command
        ? `${button("Start measuring this", `type="button" data-action="advise-apply" data-index="${index}"`)}
           <span class="kpi-sub" style="margin-left:10px">Installed as a dry run: it records what it
             would have done and changes nothing.</span>`
        : '<p class="kpi-sub">No rule to write. This one is a change in your own code.</p>'
    }
  </div>`;
}

function proposals(list) {
  if (list.length === 0) {
    return `<div class="card"><p style="margin:0"><strong>Nothing to propose.</strong></p>
      <p class="kpi-sub" style="margin-top:8px">That is a real answer, not an empty one: every check
        ran and none of them cleared its threshold. Thresholds are deliberately conservative, because
        a list of twelve suggestions worth a dollar each teaches you to stop reading the list.</p></div>`;
  }
  let current;
  return list
    .map((p, i) => {
      const heading = p.intent === current ? "" : `<h2 style="margin-top:22px">${HEADINGS[p.intent]}</h2>`;
      current = p.intent;
      return heading + proposalCard(p, i);
    })
    .join("");
}

function autopilotSection(pilot) {
  const s = pilot.settings;
  const tag = s.level === "off" ? "off" : s.level === "monitor" ? "monitor" : "on";
  const rows = pilot.actions
    .map(
      (a) => `<tr>
        <td>${relativeTime(a.actedAt)}</td>
        <td style="white-space:normal">${escapeHtml(a.summary)}<br /><span class="kpi-sub">${escapeHtml(a.evidence)}</span></td>
        <td>${a.undoneAt ? '<span class="tag off">undone</span>' : '<span class="tag on">in place</span>'}</td>
      </tr>`,
    )
    .join("");
  const run = view.lastRun;
  return `<div class="card">
    <p style="margin:0 0 10px"><span class="tag ${tag}">${escapeHtml(s.level)}</span>
      ${
        s.level === "off"
          ? "Nothing is changed on your account unless you switch this on."
          : `At most ${count(s.maxActions)} change${s.maxActions === 1 ? "" : "s"} per run, and none covering more than ${s.maxImpactPct}% of your spend.`
      }</p>
    <p class="kpi-sub"><strong>Monitor</strong> creates rules that measure and change nothing.
      <strong>Apply</strong> also switches on routing that already replayed with a saving. It can never
      refuse a call or set a budget, at any level.</p>
    <form id="autopilot-form" style="margin-top:14px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      <label style="display:block;margin-bottom:14px"><span class="rail" style="display:block;margin-bottom:6px">Level</span>
        <select name="level" style="padding:9px 11px">
          ${["off", "monitor", "apply"].map((l) => `<option value="${l}" ${l === s.level ? "selected" : ""}>${l}</option>`).join("")}
        </select></label>
      ${field("Max share of spend per change (%)", "maxImpactPct", "number", `value="${s.maxImpactPct}" min="1" max="100" style="width:120px"`)}
      ${field("Max changes per run", "maxActions", "number", `value="${s.maxActions}" min="1" max="50" style="width:120px"`)}
      ${button("Save", 'type="submit"')}
    </form>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${button("Run now", 'type="button" data-action="autopilot-run"')}
      ${button("Undo everything it did", 'type="button" data-action="autopilot-undo"')}
    </div>
    ${
      run
        ? `<div style="margin-top:14px"><p><strong>Looked at ${count(run.considered)} proposal${run.considered === 1 ? "" : "s"}
             at level ${escapeHtml(run.level)}.</strong> ${run.taken.length === 0 ? "Changed nothing." : ""}</p>
           ${run.taken.map((a) => `<p style="margin:6px 0">${escapeHtml(a.summary)}<br /><span class="kpi-sub">${escapeHtml(a.evidence)}</span></p>`).join("")}
           ${run.declined.length ? `<p class="kpi-sub" style="margin-top:8px">Left alone:</p>${run.declined.map((d) => `<p class="kpi-sub" style="margin:2px 0">${escapeHtml(d.headline)}: ${escapeHtml(d.because)}</p>`).join("")}` : ""}
           </div>`
        : ""
    }
    ${
      rows
        ? `<div class="scroll-x" style="margin-top:14px"><table>
             <thead><tr><th>When</th><th>What it did</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : ""
    }
  </div>`;
}

export async function render() {
  const t = state.tenantId;
  const [advice, pilot] = await Promise.all([
    call("GET", `/console/${t}/advise?days=${view.days}`),
    call("GET", `/console/${t}/autopilot`),
  ]);
  view.proposals = advice.proposals;

  return `
    <h2>Advice</h2>
    <p class="section-note">CostGrid reads your own traffic and proposes rules. Each one is replayed
      against the same window, so the saving is shown before you switch anything on. It proposes; it
      does not apply anything until you say so.</p>
    ${flashBanner()}
    <form id="advice-window" style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
      <span class="rail">Window</span>
      <select name="days" style="padding:8px">
        ${[7, 30, 90].map((d) => `<option value="${d}" ${d === view.days ? "selected" : ""}>${d} days</option>`).join("")}
      </select>
      ${button("Show", 'type="submit"')}
    </form>
    ${proposals(view.proposals)}

    <h2 style="margin-top:26px">Autopilot</h2>
    <p class="section-note">Let CostGrid act on its own findings, inside limits you set. Off by
      default.</p>
    ${autopilotSection(pilot)}`;
}

export async function submit(form) {
  const t = state.tenantId;
  if (form.id === "advice-window") {
    view.days = Number(formValues(form).days);
    return true;
  }
  if (form.id === "autopilot-form") {
    const v = formValues(form);
    const saved = await call("PUT", `/console/${t}/autopilot`, {
      level: v.level,
      maxImpactPct: Number(v.maxImpactPct),
      maxActions: Number(v.maxActions),
    });
    state.flash = { kind: "ok", text: `Autopilot is now ${saved.level}.` };
    return true;
  }
  return false;
}

export async function click(target) {
  const t = state.tenantId;
  const action = target.dataset.action;
  if (action === "advise-apply") {
    const proposal = view.proposals[Number(target.dataset.index)];
    if (!proposal) return true;
    await call("POST", `/console/${t}/advise/apply`, { command: proposal.command, days: view.days });
    state.flash = {
      kind: "ok",
      text: "Rule installed as a dry run. Read a week of what it would have done before enforcing it.",
    };
    return true;
  }
  if (action === "autopilot-run") {
    view.lastRun = await call("POST", `/console/${t}/autopilot/run?days=${view.days}`);
    return true;
  }
  if (action === "autopilot-undo") {
    const { rulesDisabled } = await call("POST", `/console/${t}/autopilot/undo`);
    view.lastRun = null;
    state.flash = {
      kind: "ok",
      text:
        rulesDisabled === 0
          ? "Nothing to undo."
          : `Switched off ${rulesDisabled} rule${rulesDisabled === 1 ? "" : "s"} autopilot created. The record of them is kept.`,
    };
    return true;
  }
  return false;
}
