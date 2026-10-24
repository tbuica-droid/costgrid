/**
 * Setup step 3: match each key to an agent.
 *
 * An agent is one job the owner's AI does ("Support bot"). The providers
 * report sources (a Claude API key or workspace, an OpenAI project or key, or
 * the whole account); here the owner says which agent uses each one, or that
 * several agents share it, and gives each agent a purpose preset. The preset
 * says what counts as a finished job, which later steps measure cost against.
 *
 * Three lists, all from GET /console/:t/agents: agent cards with the sources
 * matched to them, sources not matched yet, and shared sources with a guide to
 * splitting them. Imported provider cost and cost measured by the CostGrid
 * proxy are separate figures and are never added together.
 *
 * Forms and buttons go through console.js, which redraws the page after every
 * one (it refetches the agents). Results are kept in `results` per card and
 * row so the redraw can say what happened, and which folds were open is kept
 * in `openFolds` so the redraw does not close them. Picking "New agent…"
 * reveals its fields in place, with no redraw, so nothing typed is lost.
 */

import { call, formValues, state } from "./console-api.js";
import { button, count, escapeHtml, field, money, relativeTime } from "./ui.js";
import {
  codeNameAfter,
  codeNameBefore,
  confirmDelete,
  COPY,
  estimateNote,
  KINDS,
  lastCall,
  meteredLine,
  PARENT_NAMES,
  PROVIDER_NAMES,
  purposeLeft,
  reportLine,
  seen,
  sharedToSplit,
  SPLIT,
  SPLIT_GUIDES,
  unmatchedLeft,
} from "./console-agents-text.js";

/** The latest action's outcome, keyed by card or row: { ok, note? } or { ok: false, error }. */
const results = new Map();
/** The copy, escaped once for markup. Error messages use COPY and are escaped where shown. */
const TEXT = Object.fromEntries(Object.entries(COPY).map(([k, v]) => [k, escapeHtml(v)]));
/** Which <details> folds are open, by their data-fold key. */
const openFolds = new Set();

// JSON, not a control-character separator: fold keys sit in HTML attributes, where NUL does not survive.
const sourceKey = (s) => JSON.stringify(["source", s.provider, s.kind, s.id ?? ""]);
const agentKey = (id) => JSON.stringify(["agent", id]);
const hasCost = (s) => Number(s.costUsd) > 0;

/** The URL path of a source. A whole-account source has an empty id, which travels as "_". */
const sourcePath = (s) => [s.provider, s.kind, s.id || "_"].map(encodeURIComponent).join("/");
const agentPath = (id) => `/console/${state.tenantId}/agents/${encodeURIComponent(id)}`;

const parts = (payload) => ({
  agents: payload?.agents ?? [],
  unassigned: payload?.unassigned ?? [],
  shared: payload?.shared ?? [],
  proxyOnly: payload?.proxyOnly ?? [],
});

/** Every source in the payload, wherever it sits. */
export function allSources(payload) {
  const { agents, unassigned, shared } = parts(payload);
  return [...agents.flatMap((a) => a.sources ?? []), ...unassigned, ...shared];
}

/** What is left before step 3 is done: sources with spending and no agent, agents with spending and no purpose. */
function pending(payload) {
  const { agents, unassigned } = parts(payload);
  return {
    unmatched: unassigned.filter(hasCost).length,
    noPurpose: agents.filter((a) => !a.purposeId && (a.sources ?? []).some(hasCost)).length,
  };
}

/**
 * Step 3 is done when there is at least one source and every source with
 * spending is either on an agent that has a purpose, or marked shared.
 */
export function agentsDone(payload) {
  if (!allSources(payload).length) return false;
  const left = pending(payload);
  return left.unmatched === 0 && left.noPurpose === 0;
}

// ------------------------------------------------------------- formatting

/** The provider's own name for it, else enough of the id to recognise it. */
function describe(source) {
  if (source.label) return source.label;
  if (source.kind === "account" || !source.id) return "All usage on this account";
  // A long provider id is shortened; a name from a usage file ("Support / support-bot") is not.
  const id = String(source.id);
  return id.length > 14 && !/\s/.test(id) ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function formatDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(day);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const dayRange = (from, to) =>
  !from || !to ? "" : from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;

/** The data attributes that name a source on a form or button. */
const sourceAttrs = (s) =>
  `data-provider="${escapeHtml(s.provider)}" data-kind="${escapeHtml(s.kind)}" data-source-id="${escapeHtml(s.id ?? "")}"`;

const sourceOf = (data) => ({ provider: data.provider, kind: data.kind, id: data.sourceId ?? "" });

function status(key) {
  const result = results.get(key);
  if (!result) return "";
  return result.ok
    ? `<span class="tag on">${TEXT.saved}</span>${result.note ? ` <span class="kpi-sub">${escapeHtml(result.note)}</span>` : ""}`
    : `<span class="tag block">${TEXT.notSaved}</span> <span class="kpi-sub">${escapeHtml(result.error)}</span>`;
}

const statusSlot = (key) => `<span class="agents-status" aria-live="polite">${status(key)}</span>`;

const fold = (key) => (openFolds.has(key) ? " open" : "");

// ------------------------------------------------------------- pieces

function sourceHead(source) {
  const parent =
    source.parentLabel && source.kind !== "workspace" && source.kind !== "project"
      ? `${PARENT_NAMES[source.provider] ?? "Group"}: ${source.parentLabel}`
      : "";
  const range = dayRange(source.firstDay, source.lastDay);
  const meta = [parent, range ? seen(range) : ""].filter(Boolean).join(" · ");
  return `<div class="source-head">
      <span class="tag">${escapeHtml(PROVIDER_NAMES[source.provider] ?? source.provider)}</span>
      <span class="tag">${escapeHtml(KINDS[source.kind] ?? source.kind)}</span>
      <span class="source-label">${escapeHtml(describe(source))}</span>
      <span class="source-cost"><strong>${money(source.costUsd)}</strong> in the last 90 days</span>
    </div>
    ${meta ? `<p class="kpi-sub agents-meta">${escapeHtml(meta)}</p>` : ""}`;
}

function presetGroup(presets, chosen) {
  if (!presets.length) return `<p class="kpi-sub">${TEXT.presetsMissing}</p>`;
  const options = presets
    .map(
      (p) => `<label class="preset-option">
        <input type="radio" name="purposeId" value="${escapeHtml(p.id)}"${p.id === chosen ? " checked" : ""} />
        <span><span class="preset-label">${escapeHtml(p.label)}</span>
          <span class="preset-job">Finished job: ${escapeHtml(p.finishedJob)}</span></span>
      </label>`,
    )
    .join("");
  return `<fieldset class="preset-group"><legend>${TEXT.purposeLegend}</legend>${options}</fieldset>`;
}

/** Once a purpose is chosen, the list folds away behind it so the card stays short. */
function purposeChoice(agent, presets) {
  const chosen = presets.find((p) => p.id === agent.purposeId);
  if (!chosen) return presetGroup(presets, agent.purposeId);
  const key = `purpose:${agent.id}`;
  return `<details class="agent-fold" data-fold="${escapeHtml(key)}"${fold(key)}>
      <summary>${TEXT.purposeLegend}: <strong>${escapeHtml(chosen.label)}</strong>
        <span class="preset-job">Finished job: ${escapeHtml(chosen.finishedJob)}</span></summary>
      ${presetGroup(presets, agent.purposeId)}
    </details>`;
}

function costLines(agent) {
  const lines = [];
  if ((agent.sources ?? []).length) {
    const cost = agent.imported?.costUsd ?? "0";
    const estimated = Number(agent.imported?.estimatedUsd ?? 0);
    const note = estimated > 0 ? ` (${estimateNote(money(estimated), estimated >= Number(cost))})` : "";
    lines.push(`${reportLine(money(cost))}${note}`);
  } else {
    lines.push(TEXT.noSources);
  }
  const calls = Number(agent.metered?.calls ?? 0);
  if (calls > 0) {
    const ago = agent.lastSeenAt ? ` · ${lastCall(relativeTime(agent.lastSeenAt))}` : "";
    lines.push(`${meteredLine(money(agent.metered.costUsd), calls)}${ago}`);
  }
  return `<div class="agent-costs">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}</div>`;
}

function agentSource(source) {
  const matched = source.assignedBy === "match";
  return `<li class="agent-source">
      ${sourceHead(source)}
      ${matched ? `<p class="agents-matched">${TEXT.matched}</p>` : ""}
      <div class="form-row">
        ${button(matched ? COPY.notSameKey : COPY.remove, `type="button" data-action="agents-unassign" ${sourceAttrs(source)}`, "sm")}
        ${statusSlot(sourceKey(source))}
      </div>
    </li>`;
}

function agentCard(agent, presets, index) {
  const sources = agent.sources ?? [];
  const adv = `adv:${agent.id}`;
  const missing = !agent.purposeId ? '<span class="tag warn">No purpose yet</span>' : "";
  return `<article class="agent-card" aria-labelledby="agent-${index}">
      <div class="agent-card-head"><h4 id="agent-${index}">${escapeHtml(agent.name ?? agent.id)}</h4>${missing}</div>
      ${costLines(agent)}
      ${sources.length ? `<ul class="agent-sources">${sources.map(agentSource).join("")}</ul>` : ""}
      <form class="agent-form" data-agent-id="${escapeHtml(agent.id)}">
        ${field(COPY.nameLabel, "name", "text", `value="${escapeHtml(agent.name ?? "")}" maxlength="80" placeholder="${TEXT.namePlaceholder}"`)}
        ${purposeChoice(agent, presets)}
        <div class="form-row">
          ${button(COPY.save, 'type="submit"', "secondary")}
          ${statusSlot(agentKey(agent.id))}
        </div>
      </form>
      <details class="agent-fold agent-advanced" data-fold="${escapeHtml(adv)}"${fold(adv)}>
        <summary>${TEXT.advanced}</summary>
        <p class="kpi-sub">${escapeHtml(codeNameBefore)} <code>${escapeHtml(agent.id)}</code>${escapeHtml(codeNameAfter)}</p>
        ${button(COPY.deleteAgent,
          `type="button" data-action="agents-delete" data-agent-id="${escapeHtml(agent.id)}"
            data-agent-name="${escapeHtml(agent.name ?? agent.id)}" data-origin="${escapeHtml(agent.origin ?? "")}"`,
          "danger btn-sm",
        )}
      </details>
    </article>`;
}

/** The fields for a new agent, hidden (and left out of the form) until "New agent…" is picked. */
function newAgentFields(presets, proxyOnly) {
  const link = proxyOnly.length
    ? `<label class="field"><span class="field-label">${TEXT.linkProxyLabel}</span>
        <select name="linkProxyId">
          <option value="">${TEXT.linkProxyNone}</option>
          ${proxyOnly
            .map((p) => {
              const calls = Number(p.metered?.calls ?? 0);
              const extra = calls > 0 ? ` (${count(calls)} ${calls === 1 ? "call" : "calls"})` : "";
              return `<option value="${escapeHtml(p.id)}">${escapeHtml(`${p.id}${extra}`)}</option>`;
            })
            .join("")}
        </select>
        <span class="kpi-sub">${TEXT.linkProxyNote}</span></label>`
    : "";
  return `<fieldset class="agents-new" data-new-agent hidden disabled>
      <legend class="visually-hidden">${TEXT.newAgentOption}</legend>
      ${field(COPY.nameLabel, "name", "text", `maxlength="80" placeholder="${TEXT.namePlaceholder}"`)}
      ${presetGroup(presets, null)}
      ${link}
    </fieldset>`;
}

/** A source with no agent: pick one, make one, or say several agents use it. */
function assignForm(source, ctx, { shared }) {
  const options = ctx.agents
    .map((a) => `<option value="agent:${escapeHtml(a.id)}">${escapeHtml(a.name ?? a.id)}</option>`)
    .join("");
  const guideKey = `split:${sourceKey(source)}`;
  const guide = SPLIT_GUIDES[source.provider];
  return `<form class="source-form agents-assign-form" ${sourceAttrs(source)}>
      ${sourceHead(source)}
      <label class="field"><span class="field-label">${TEXT.chooseLabel}</span>
        <select name="choice" data-agent-choice>
          <option value="">${TEXT.choosePlaceholder}</option>
          ${options}
          <option value="new">${TEXT.newAgentOption}</option>
          ${shared ? "" : `<option value="shared">${TEXT.sharedOption}</option>`}
        </select></label>
      ${newAgentFields(ctx.presets, ctx.proxyOnly)}
      <div class="form-row">
        ${button(COPY.save, 'type="submit"', "secondary")}
        ${shared ? button(COPY.notShared, `type="button" data-action="agents-unshare" ${sourceAttrs(source)}`, "quiet") : ""}
        ${statusSlot(sourceKey(source))}
      </div>
      ${shared && guide ? splitGuide(guide, guideKey) : ""}
    </form>`;
}

function splitGuide(steps, key) {
  const items = steps
    .map(
      (s) => `<li>${escapeHtml(s.text)}${
        s.link
          ? ` <a href="${escapeHtml(s.link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.link.text)}</a>`
          : ""
      }</li>`,
    )
    .join("");
  return `<details class="agent-fold split-guide" data-fold="${escapeHtml(key)}"${fold(key)}>
      <summary>${escapeHtml(SPLIT.title)}</summary>
      <p class="kpi-sub">${escapeHtml(SPLIT.intro)}</p>
      <ol class="howto">${items}</ol>
      <p class="kpi-sub">${escapeHtml(SPLIT.before)}</p>
    </details>`;
}

function section(title, note, body) {
  return `<section class="agents-section">
      <h3>${title}</h3>
      ${note ? `<p class="section-note">${note}</p>` : ""}
      ${body}
    </section>`;
}

function finishRow(payload, finished) {
  if (!finished) return "";
  const { shared } = parts(payload);
  let note = "";
  if (agentsDone(payload)) {
    if (shared.length) note = `<span class="tag warn">${escapeHtml(sharedToSplit(shared.length))}</span>`;
  } else if (allSources(payload).length) {
    const left = pending(payload);
    const what = [left.unmatched ? unmatchedLeft(left.unmatched) : "", left.noPurpose ? purposeLeft(left.noPurpose) : ""];
    note = `<span class="kpi-sub">${escapeHtml(what.filter(Boolean).join(", "))}</span>`;
  }
  return `<p class="purpose-finish agents-finish"><a class="btn btn-primary" href="/">${TEXT.finish}</a>${note}</p>`;
}

/**
 * The body of step 3. `payload` is GET /console/:t/agents, `presets` the array
 * from /console/presets; `finished` shows the link out of setup.
 */
export function renderAgents(payload, presets, finished) {
  const ctx = { ...parts(payload), presets };
  const cards = ctx.agents.length
    ? `<div class="agent-list">${ctx.agents.map((a, i) => agentCard(a, presets, i)).join("")}</div>`
    : `<p class="kpi-sub">${TEXT.noAgents}</p>`;

  if (!allSources(payload).length) {
    return `<p class="section-note">${TEXT.empty}</p>
      ${ctx.agents.length ? section(TEXT.agentsTitle, "", cards) : ""}
      ${finishRow(payload, finished)}`;
  }
  const list = (sources, shared) =>
    `<div class="source-list">${sources.map((s) => assignForm(s, ctx, { shared })).join("")}</div>`;
  return `<p class="section-note">${TEXT.intro}</p>
    ${section(TEXT.agentsTitle, "", cards)}
    ${ctx.unassigned.length ? section(TEXT.unassignedTitle, TEXT.unassignedNote, list(ctx.unassigned, false)) : ""}
    ${ctx.shared.length ? section(TEXT.sharedTitle, TEXT.sharedNote, list(ctx.shared, true)) : ""}
    ${finishRow(payload, finished)}`;
}

// ------------------------------------------------------------- actions

async function putAgent(source, body) {
  return call("PUT", `/console/${state.tenantId}/sources/${sourcePath(source)}/agent`, body);
}

/** Assign a source and say so on its row, noting a twin that was matched with it. */
async function assignTo(source, agentId) {
  const reply = await putAgent(source, { agentId });
  results.set(sourceKey(source), { ok: true, note: reply?.matched ? COPY.alsoMatched : undefined });
}

async function createAndAssign(source, values) {
  const name = String(values.name ?? "").trim();
  if (!name) throw new Error(COPY.needName);
  const body = { name };
  if (values.purposeId) body.purposeId = String(values.purposeId);
  if (values.linkProxyId) body.linkProxyId = String(values.linkProxyId);
  const { id } = await call("POST", `/console/${state.tenantId}/agents`, body);
  try {
    await assignTo(source, id);
  } catch (error) {
    throw new Error(`${COPY.createdNotMatched} ${error.message}`);
  }
}

async function assign(form) {
  const source = sourceOf(form.dataset);
  const values = formValues(form);
  const choice = String(values.choice ?? "");
  if (choice.startsWith("agent:")) await assignTo(source, choice.slice("agent:".length));
  else if (choice === "new") await createAndAssign(source, values);
  else if (choice === "shared") {
    await putAgent(source, { agentId: null, shared: true });
    results.set(sourceKey(source), { ok: true });
  } else throw new Error(COPY.needChoice);
}

async function saveAgent(form) {
  const id = form.dataset.agentId;
  const values = formValues(form);
  const name = String(values.name ?? "").trim();
  if (!name) throw new Error(COPY.needName);
  const body = { name };
  if (values.purposeId) body.purposeId = String(values.purposeId);
  await call("PATCH", agentPath(id), body);
  results.set(agentKey(id), { ok: true });
}

/** Run one action; whatever goes wrong is shown on `key`'s card or row, not as a page banner. */
async function attempt(key, action) {
  results.clear();
  try {
    await action();
  } catch (error) {
    results.set(key, { ok: false, error: error.message });
  }
}

export async function submit(form) {
  if (form.classList.contains("agent-form")) {
    await attempt(agentKey(form.dataset.agentId), () => saveAgent(form));
    return true;
  }
  if (form.classList.contains("agents-assign-form")) {
    for (const b of form.querySelectorAll("button")) b.disabled = true;
    await attempt(sourceKey(sourceOf(form.dataset)), () => assign(form));
    return true;
  }
  return false;
}

export async function click(target) {
  const action = target.dataset.action;
  if (action === "agents-unassign" || action === "agents-unshare") {
    const source = sourceOf(target.dataset);
    const body = action === "agents-unshare" ? { agentId: null, shared: false } : { agentId: null };
    await attempt(sourceKey(source), async () => {
      await putAgent(source, body);
      results.set(sourceKey(source), { ok: true });
    });
    return true;
  }
  if (action === "agents-delete") {
    const { agentId, agentName, origin } = target.dataset;
    if (!confirm(confirmDelete(agentName, origin))) return true;
    await attempt(agentKey(agentId), () => call("DELETE", agentPath(agentId)));
    return true;
  }
  return false;
}

// ------------------------------------------------------------- in place

// "New agent…" shows its fields; anything else hides them and leaves them out of the form.
document.addEventListener("change", (event) => {
  const select = event.target;
  if (!(select instanceof Element) || !select.matches("[data-agent-choice]")) return;
  const fields = select.form?.querySelector("[data-new-agent]");
  if (!fields) return;
  const on = select.value === "new";
  fields.hidden = !on;
  fields.disabled = !on;
  if (on) fields.querySelector('input[name="name"]')?.focus();
});

// <details> fires "toggle" without bubbling, so listen while it passes down.
document.addEventListener(
  "toggle",
  (event) => {
    const el = event.target;
    if (!(el instanceof Element) || !el.matches("details[data-fold]")) return;
    if (el.open) openFolds.add(el.dataset.fold);
    else openFolds.delete(el.dataset.fold);
  },
  true,
);
