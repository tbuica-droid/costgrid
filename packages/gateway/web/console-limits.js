/**
 * Limits: stop an agent, set a limit, see every rule and what it did, and
 * choose where alerts go.
 *
 * The same rule engine as the command line. A new limit starts by measuring
 * unless you choose otherwise, because a limit that refuses calls the moment
 * it is typed in, before anyone has seen what it would refuse, is how a cost
 * control becomes an outage.
 */

import { call, flashBanner, formValues, state } from "./console-api.js";
import { button, count, escapeHtml, field, money, pageHead, relativeTime } from "./ui.js";

const view = { data: null };

const ACTIONS = {
  monitor: "Measure only",
  warn: "Warn, let calls through",
  block: "Refuse calls over the limit",
};

/** A small outline pill. `tone` is "danger" for stopping, "good" for resuming. */
const small = (text, attrs, tone = "") =>
  `<button type="button" class="btn btn-sm${tone ? ` btn-${tone}` : ""}" ${attrs}>${escapeHtml(text)}</button>`;

function scopeText(scope) {
  if (scope.kind === "tenant") return "everything";
  if (scope.kind === "department") return `team ${scope.department}`;
  return scope.agentId;
}

function ruleText(rule) {
  switch (rule.kind) {
    case "budget":
      return `${money(rule.limitUsd)} per ${rule.window}` + (rule.fallbackModel ? `, then ${rule.fallbackModel}` : "");
    case "run-budget":
      return `${money(rule.limitUsd)} per run` + (rule.fallbackModel ? `, then ${rule.fallbackModel}` : "");
    case "run-steps":
      return `${count(rule.limit)} calls per run`;
    case "run-depth":
      return `${count(rule.limit)} delegation hops`;
    case "stop":
      return "stopped";
    case "max-reasoning":
      return `reasoning at most ${[rule.effort, rule.budgetTokens ? `${count(rule.budgetTokens)} thinking tokens` : null]
        .filter(Boolean)
        .join(", ")}`;
    case "route":
      return `send ${rule.from?.length ? rule.from.join(", ") : "any model"} to ${rule.toModel}`;
    case "max-output-tokens":
      return `answers up to ${count(rule.limit)} tokens`;
    case "tool-denylist":
      return `may not use ${rule.tools.join(", ")}`;
    case "tool-allowlist":
      return `may only use ${rule.tools.join(", ")}`;
    default:
      return `${rule.kind} ${(rule.models ?? []).join(", ")}`;
  }
}

/**
 * What a rule does when it fires, in words that fit the rule. A routing rule
 * with action "block" does not refuse anything; it switches the model.
 */
function actionLabel(rule, action) {
  if (action === "monitor") return rule.kind === "route" ? "Dry run" : ACTIONS.monitor;
  if (rule.kind === "route") return "Switching model";
  if (rule.fallbackModel && action === "block") return "Switch model when over";
  if (rule.kind === "stop") return "Refusing every call";
  return ACTIONS[action];
}

function stopsSection(d) {
  const stops = d.rules.filter((r) => r.rule.kind === "stop" && r.enabled);
  const stoppedAgent = new Map(stops.filter((s) => s.scope.kind === "agent").map((s) => [s.scope.agentId, s]));
  const everything = stops.find((s) => s.scope.kind === "tenant");

  const rows = d.agents.length
    ? d.agents
        .map((a) => {
          const stop = stoppedAgent.get(a.id);
          return `<tr>
            <td><strong>${escapeHtml(a.id)}</strong><br /><span class="kpi-sub">${escapeHtml(a.department)}</span></td>
            <td>${relativeTime(a.lastSeenAt)}</td>
            <td>${stop ? '<span class="tag off">stopped</span>' : '<span class="tag on">running</span>'}</td>
            <td class="num">${
              stop
                ? small("Resume", `data-action="limits-resume" data-id="${escapeHtml(stop.id)}"`, "good")
                : small("Stop", `data-action="limits-stop-agent" data-agent="${escapeHtml(a.id)}"`, "danger")
            }</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="4" class="kpi-sub">No agents have sent a call yet.</td></tr>';

  const others = stops.filter((s) => s.scope.kind === "department");
  return `<div class="card">
    <p style="margin:0 0 10px">${
      everything
        ? `<span class="tag off">everything stopped</span> since ${relativeTime(everything.createdAt)} by
           ${escapeHtml(everything.owner ?? "someone")}. ${small("Resume everything", `data-action="limits-resume" data-id="${escapeHtml(everything.id)}"`, "good")}`
        : `Stopping refuses the next call before it reaches the provider. Nothing is billed, other agents
           are untouched, and resuming keeps the record. ${small("Stop everything", 'data-action="limits-stop-all"', "danger")}`
    }</p>
    ${others
      .map(
        (s) => `<p class="kpi-sub">Team ${escapeHtml(s.scope.department)} is stopped.
          ${small("Resume", `data-action="limits-resume" data-id="${escapeHtml(s.id)}"`, "good")}</p>`,
      )
      .join("")}
    <div class="scroll-x"><table>
      <thead><tr><th>Agent</th><th>Last call</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
  </div>`;
}

function newLimitForm(d) {
  const agents = d.agents.map((a) => `<option value="agent:${escapeHtml(a.id)}">${escapeHtml(a.id)}</option>`).join("");
  const teams = [...new Set(d.agents.map((a) => a.department))]
    .map((t) => `<option value="department:${escapeHtml(t)}">Team ${escapeHtml(t)}</option>`)
    .join("");
  const models = d.models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)} (${m.tier})</option>`).join("");
  const select = (label, name, options) => `<label class="field">
      <span class="field-label">${escapeHtml(label)}</span>
      <select name="${name}">${options}</select></label>`;

  return `<form id="limit-form" class="card">
    ${select(
      "What to limit",
      "kind",
      `<option value="budget:month">Spend per month</option>
       <option value="budget:day">Spend per day</option>
       <option value="run-budget">Spend per run (one task, start to finish)</option>
       <option value="run-steps">Calls per run (stops loops)</option>
       <option value="max-reasoning">How much the model may reason</option>`,
    )}
    ${select("Who it applies to", "scope", `<option value="tenant">Everything</option>${teams}${agents}`)}
    ${field("Amount in dollars, or number of calls", "amount", "text", 'placeholder="250"')}
    ${select("Reasoning cap (for a reasoning limit)", "effort", `<option value="">none</option>${d.efforts.map((e) => `<option>${e}</option>`).join("")}`)}
    ${select("When it is reached", "action", Object.entries(ACTIONS).map(([v, t]) => `<option value="${v}">${t}</option>`).join(""))}
    ${select("Instead of refusing, switch to (optional)", "fallbackModel", `<option value="">do not switch</option>${models}`)}
    ${field("Owner: who answers for this limit", "owner", "text", 'placeholder="finance@yourcompany.com"')}
    ${field("Reason", "reason", "text", 'placeholder="Support bot pilot, agreed with finance"')}
    ${button("Add limit", 'type="submit"')}
    <p class="kpi-sub" style="margin-top:10px">Start with "Measure only" for a week: the register below shows
      every time it would have fired, and you can switch it to refusing once that looks right.</p>
  </form>`;
}

function registerSection(d) {
  const rules = d.rules.filter((r) => r.rule.kind !== "stop" || r.enabled);
  if (rules.length === 0) return '<div class="card"><p class="kpi-sub" style="margin:0">No rules yet.</p></div>';
  const rows = rules
    .map((r) => {
      const fired = r.fired.block + r.fired.warn + r.fired.monitor;
      return `<tr>
        <td style="white-space:normal;min-width:200px"><strong>${escapeHtml(r.name)}</strong><br />
          <span class="kpi-sub">${escapeHtml(ruleText(r.rule))} · ${escapeHtml(scopeText(r.scope))}</span></td>
        <td>${r.enabled ? `<span class="tag ${r.action === "monitor" ? "monitor" : "on"}">${escapeHtml(actionLabel(r.rule, r.action))}</span>` : '<span class="tag off">off</span>'}</td>
        <td style="white-space:normal">${r.owner ? escapeHtml(r.owner) : '<span class="tag warn">no owner</span>'}
          ${r.reason ? `<br /><span class="kpi-sub">${escapeHtml(r.reason)}</span>` : ""}</td>
        <td style="white-space:nowrap">${count(fired)} time${fired === 1 ? "" : "s"}<br /><span class="kpi-sub">${
          r.lastFiredAt ? `last ${relativeTime(r.lastFiredAt)}` : "never fired"
        }${r.fired.block ? `, ${count(r.fired.block)} refused` : ""}</span></td>
        <td><details><summary class="kpi-sub">${count(r.history.length)} change${r.history.length === 1 ? "" : "s"}</summary>
          ${r.history.map((h) => `<div class="kpi-sub">${new Date(h.at).toISOString().slice(0, 16).replace("T", " ")} ${escapeHtml(h.action)} by ${escapeHtml(h.by)}</div>`).join("")}</details></td>
        <td class="num">${
          r.rule.kind === "stop"
            ? ""
            : small(r.enabled ? "Switch off" : "Switch on", `data-action="limits-toggle" data-id="${escapeHtml(r.id)}" data-enabled="${r.enabled}"`)
        }</td>
      </tr>`;
    })
    .join("");
  return `<div class="card scroll-x"><table>
    <thead><tr><th>Rule</th><th>Action</th><th>Owner and reason</th><th>Fired, 30 days</th><th>History</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

const pct = (f) => `${f > 0 ? "+" : ""}${(f * 100).toFixed(0)}%`;

function measuredSection(list) {
  if (list.length === 0) {
    return `<p class="kpi-sub">Nothing to measure yet. Once a rule moves traffic to a cheaper model, this compares
      what calls and whole runs cost before and after, on your own traffic.</p>`;
  }
  return list
    .map((m) => {
      const verdict = {
        cheaper: '<span class="tag on">cheaper, measured</span>',
        "more-expensive": '<span class="tag off">more expensive, measured</span>',
        "no-change": '<span class="tag monitor">no real difference</span>',
        "not-enough-data": '<span class="tag monitor">not enough data yet</span>',
      }[m.verdict];
      const line = (label, b, a) =>
        `<tr><td>${label}</td><td class="num">${b ?? "—"}</td><td class="num">${a ?? "—"}</td></tr>`;
      return `<div class="card" style="margin-bottom:12px">
        <p style="margin:0 0 8px">${verdict} <strong>${escapeHtml(m.fromModel)} → ${escapeHtml(m.toModel)}</strong>
          <span class="kpi-sub">by "${escapeHtml(m.policyName)}"</span></p>
        <div class="scroll-x"><table><thead><tr><th></th><th class="num">Before</th><th class="num">After</th></tr></thead><tbody>
          ${line("Calls", count(m.before.calls), count(m.after.calls))}
          ${line("Cost per call", m.before.costPerCallUsd && `$${Number(m.before.costPerCallUsd).toFixed(5)}`, m.after.costPerCallUsd && `$${Number(m.after.costPerCallUsd).toFixed(5)}`)}
          ${line("Output tokens per call", m.before.outputTokensPerCall, m.after.outputTokensPerCall)}
          ${line("Cost per run", m.before.costPerRunUsd && money(m.before.costPerRunUsd), m.after.costPerRunUsd && money(m.after.costPerRunUsd))}
        </tbody></table></div>
        <p class="kpi-sub" style="margin-top:8px">${
          m.changePerCall === null ? "" : `Measured change per call: ${pct(m.changePerCall)}. `
        }${m.changePerRun === null ? "" : `Per run: ${pct(m.changePerRun)}. `}${
          m.estimatedSavingPerCallUsd === null || Number(m.estimatedSavingPerCallUsd) === 0
            ? ""
            : `The estimate, which assumes the cheaper model uses the same tokens, said $${Number(m.estimatedSavingPerCallUsd).toFixed(5)} saved per call. `
        }${escapeHtml(m.caveat)}</p>
      </div>`;
    })
    .join("");
}

function alertsSection(d) {
  const s = d.alertSettings;
  const rows = d.alerts
    .map(
      (a) => `<tr><td>${relativeTime(a.occurredAt)}</td><td style="white-space:normal">${escapeHtml(a.message)}</td>
        <td>${a.deliveredAt ? '<span class="tag on">sent</span>' : a.lastError ? `<span class="tag off" title="${escapeHtml(a.lastError)}">failed</span>` : '<span class="tag monitor">here only</span>'}</td></tr>`,
    )
    .join("");
  return `<form id="alerts-form" class="card">
      <p class="kpi-sub" style="margin-top:0">${
        s.webhookConfigured
          ? `Alerts are posted to <code>${escapeHtml(s.webhookHint)}</code>.`
          : "Paste a Slack or Discord incoming-webhook address, or any address that accepts a JSON post, to have alerts sent to a channel."
      } The address is stored encrypted and never shown again.</p>
      ${field("Webhook address", "webhookUrl", "url", `placeholder="${s.webhookConfigured ? "Leave blank to keep the current one" : "https://hooks.slack.com/services/…"}" autocomplete="off"`)}
      <label class="check"><input type="checkbox" name="desktop" ${s.desktop ? "checked" : ""} />
        Show a notification on this computer</label>
      <div class="form-row">
        ${button("Save", 'type="submit"')}
        ${button("Send a test alert", 'type="button" data-action="alerts-test"', "secondary")}
        ${s.webhookConfigured ? small("Remove address", 'data-action="alerts-remove"', "danger") : ""}
      </div>
    </form>
    ${rows ? `<div class="card scroll-x" style="margin-top:12px"><table><thead><tr><th>When</th><th>Alert</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}`;
}

export async function render() {
  const d = await call("GET", `/console/${state.tenantId}/limits`);
  view.data = d;
  return `
    ${pageHead(
      "Limits",
      `Every limit is checked before a call is sent. A call over a limit that refuses is
      answered "over budget" by CostGrid and never reaches the provider, so it is never billed.`,
    )}
    ${flashBanner()}
    <h2 style="margin-top:22px">Stop</h2>
    ${stopsSection(d)}
    <h2 style="margin-top:26px">Set a limit</h2>
    ${newLimitForm(d)}
    <h2 style="margin-top:26px">Rule register</h2>
    <p class="section-note">Every rule, who owns it, why it exists, what it did in the last 30 days and every
      change to it. A rule with no owner is flagged: unowned rules are how limits drift out of date.</p>
    ${registerSection(d)}
    <h2 style="margin-top:26px">Did switching to a cheaper model save money?</h2>
    <p class="section-note">A cheaper model can cost more overall if it thinks longer or needs more steps. This
      measures it on your traffic instead of assuming.</p>
    ${measuredSection(d.measured)}
    <h2 style="margin-top:26px">Alerts</h2>
    <p class="section-note">You are told when a limit is reached, a call is refused, traffic is switched to a
      cheaper model, or a run costs far more than that agent's runs usually do. Once each, not once per call.</p>
    ${alertsSection(d)}`;
}

function parseAmount(kind, raw) {
  const text = String(raw ?? "").trim().replace(/^\$/, "");
  if (kind === "run-steps") return { limit: Number(text) };
  if (kind === "max-reasoning") return text === "" ? {} : { budgetTokens: Number(text) };
  return { limitUsd: text };
}

export async function submit(form) {
  const t = state.tenantId;
  if (form.id === "limit-form") {
    const v = formValues(form);
    const [kind, window] = String(v.kind).split(":");
    const [scopeKind, ...rest] = String(v.scope).split(":");
    const value = rest.join(":");
    const scope =
      scopeKind === "agent" ? { kind: "agent", agentId: value } : scopeKind === "department" ? { kind: "department", department: value } : { kind: "tenant" };
    await call("POST", `/console/${t}/limits`, {
      kind,
      ...(window ? { window } : {}),
      ...parseAmount(kind, v.amount),
      ...(kind === "max-reasoning" && v.effort ? { effort: v.effort } : {}),
      ...(v.fallbackModel && (kind === "budget" || kind === "run-budget") ? { fallbackModel: v.fallbackModel } : {}),
      scope,
      action: v.action,
      owner: v.owner,
      reason: v.reason,
    });
    state.flash = {
      kind: "ok",
      text: v.action === "monitor" ? "Limit added. It is measuring: nothing is refused yet." : "Limit added and in force from the next call.",
    };
    return true;
  }
  if (form.id === "alerts-form") {
    const v = formValues(form);
    await call("PUT", `/console/${t}/alerts`, {
      ...(v.webhookUrl ? { webhookUrl: v.webhookUrl } : {}),
      desktop: form.elements.desktop.checked,
    });
    state.flash = { kind: "ok", text: "Alert settings saved." };
    return true;
  }
  return false;
}

export async function click(target) {
  const t = state.tenantId;
  const action = target.dataset.action;
  if (action === "limits-stop-agent") {
    const agentId = target.dataset.agent;
    if (!confirm(`Stop ${agentId}? Its next call will be refused until you resume it.`)) return true;
    await call("POST", `/console/${t}/stop`, { scope: { kind: "agent", agentId } });
    state.flash = { kind: "ok", text: `${agentId} is stopped. Nothing from it reaches the provider until you resume it.` };
    return true;
  }
  if (action === "limits-stop-all") {
    if (!confirm("Stop everything? Every call through CostGrid will be refused until you resume.")) return true;
    await call("POST", `/console/${t}/stop`, { scope: { kind: "tenant" } });
    state.flash = { kind: "ok", text: "Everything is stopped." };
    return true;
  }
  if (action === "limits-resume") {
    await call("POST", `/console/${t}/resume/${target.dataset.id}`);
    state.flash = { kind: "ok", text: "Resumed. The record of the stop is kept in the register and the audit log." };
    return true;
  }
  if (action === "limits-toggle") {
    const enabled = target.dataset.enabled !== "true";
    await call("PATCH", `/console/${t}/limits/${target.dataset.id}`, { enabled });
    state.flash = { kind: "ok", text: enabled ? "Rule switched on." : "Rule switched off." };
    return true;
  }
  if (action === "alerts-test") {
    const r = await call("POST", `/console/${t}/alerts/test`);
    state.flash = r.delivered
      ? { kind: "ok", text: "Test alert sent. Check the channel." }
      : r.webhookConfigured
        ? { kind: "error", text: `The channel did not accept it: ${r.error ?? "no answer"}` }
        : { kind: "ok", text: "Test alert recorded here. Add a webhook address to have it posted to a channel." };
    return true;
  }
  if (action === "alerts-remove") {
    await call("PUT", `/console/${t}/alerts`, { webhookUrl: null });
    state.flash = { kind: "ok", text: "Alert address removed." };
    return true;
  }
  return false;
}
