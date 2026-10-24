/**
 * Setup step 3: say what each workflow is for.
 *
 * One row per source the providers reported (a Claude API key or workspace,
 * an OpenAI project or key, or the whole account when nothing finer was
 * reported), with a name and one of the purpose presets. The preset says what
 * counts as a finished job, which is what later steps measure cost against.
 *
 * The presets come from the server, so the labels shown here are the ones the
 * server will accept; the server also decides the preset version.
 */

import { call, formValues, state } from "./console-api.js";
import { button, escapeHtml, field, money } from "./ui.js";

const KINDS = { key: "API key", workspace: "Workspace", project: "Project", account: "Whole account" };
const PROVIDER_NAMES = { anthropic: "Claude", openai: "OpenAI" };

/** Save results per row, so the redraw after a save can say it worked. */
const saved = {};

const rowKey = (s) => `${s.provider}\u0000${s.kind}\u0000${s.id}`;

/** Step 3 is done once every source has a purpose. */
export function purposeDone(sources) {
  return sources.length > 0 && sources.every((s) => s.purposeId);
}

/** The provider's own name for it, else enough of the id to recognise it. */
function describe(source) {
  if (source.label) return source.label;
  if (source.kind === "account" || !source.id) return "All usage on this account";
  // A long provider id is shortened; a name from a usage file ("Support / support-bot") is not.
  const id = String(source.id);
  return id.length > 14 && !/\s/.test(id) ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function presetGroup(presets, chosen) {
  if (!presets.length) return '<p class="kpi-sub">The list of purposes could not be loaded.</p>';
  const options = presets
    .map(
      (p) => `<label class="preset-option">
        <input type="radio" name="purposeId" value="${escapeHtml(p.id)}"${p.id === chosen ? " checked" : ""} />
        <span><span class="preset-label">${escapeHtml(p.label)}</span>
          <span class="preset-job">Finished job: ${escapeHtml(p.finishedJob)}</span></span>
      </label>`,
    )
    .join("");
  return `<fieldset class="preset-group"><legend>What it is for</legend>${options}</fieldset>`;
}

function statusFor(source) {
  const result = saved[rowKey(source)];
  if (!result) return "";
  return result.ok
    ? '<span class="tag on">Saved</span>'
    : `<span class="tag block">Not saved</span> <span class="kpi-sub">${escapeHtml(result.error)}</span>`;
}

function row(source, presets) {
  const where = describe(source);
  return `<form class="source-form" data-provider="${escapeHtml(source.provider)}"
      data-kind="${escapeHtml(source.kind)}" data-source-id="${escapeHtml(source.id)}">
    <div class="source-head">
      <span class="tag">${escapeHtml(PROVIDER_NAMES[source.provider] ?? source.provider)}</span>
      <span class="tag">${escapeHtml(KINDS[source.kind] ?? source.kind)}</span>
      <span class="source-label">${escapeHtml(where)}</span>
      <span class="source-cost"><strong>${money(source.costUsd)}</strong> in the last 90 days</span>
    </div>
    ${field("Name", "name", "text", `value="${escapeHtml(source.name ?? "")}" maxlength="80" placeholder="For example: Support bot"`)}
    ${presetGroup(presets, source.purposeId)}
    <div class="form-row">
      ${button("Save", 'type="submit"', "secondary")}
      <span aria-live="polite">${statusFor(source)}</span>
    </div>
  </form>`;
}

/** The body of step 3. `sources` and `presets` are the arrays from their routes. */
export function renderPurposes(sources, presets, finished) {
  const finish = finished
    ? '<p class="purpose-finish"><a class="btn btn-primary" href="/">Finish and see my costs</a></p>'
    : "";
  if (!sources.length) {
    return `<p class="section-note">Connect an account in step 2 and your keys, projects and workspaces appear here.</p>
      ${finish}`;
  }
  return `<p class="section-note">Give each one a name you will recognise and say what it does. This
      tells CostGrid what a finished job looks like, so it can show what each one costs you.</p>
    <div class="source-list">${sources.map((s) => row(s, presets)).join("")}</div>
    ${finish}`;
}

export async function submit(form) {
  if (!form.classList.contains("source-form")) return false;
  const { provider, kind, sourceId } = form.dataset;
  const source = { provider, kind, id: sourceId ?? "" };
  const values = formValues(form);
  const body = {};
  const name = String(values.name ?? "").trim();
  if (name) body.name = name;
  if (values.purposeId) body.purposeId = String(values.purposeId);
  if (!body.name && !body.purposeId) {
    saved[rowKey(source)] = { ok: false, error: "Give it a name or choose what it is for." };
    return true;
  }
  // A whole-account source has an empty id, which cannot sit in a URL; "_" stands for it.
  const path = [provider, kind, source.id || "_"].map(encodeURIComponent).join("/");
  try {
    await call("PUT", `/console/${state.tenantId}/sources/${path}`, body);
    saved[rowKey(source)] = { ok: true };
  } catch (error) {
    saved[rowKey(source)] = { ok: false, error: error.message };
  }
  return true;
}

export async function click() {
  return false;
}
