/**
 * Setup step 2: connect the owner's Claude and OpenAI accounts.
 *
 * One card per provider, each with three ways in: an admin key (imports 90
 * days, then kept in the keychain if this computer has one), a usage file
 * exported from the provider (no admin role needed), or a ready-made message
 * asking a developer to do one of the two.
 *
 * Switching tabs, the expiry picker, copying and file drops are handled here
 * with their own listeners and change the page in place: a full redraw would
 * refetch everything and empty the key field. Results are kept in `held` so
 * they survive the redraw that follows an import.
 */

import { call, state } from "./console-api.js";
import { button, count, escapeHtml, field, relativeTime } from "./ui.js";
import { COPY, DEFAULT_EXPIRY, EXPIRY_OPTIONS, PROVIDERS, replacesNote } from "./console-connect-text.js";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const TABS = [
  ["admin", "Admin key"],
  ["file", "Usage file"],
  ["developer", "Ask my developer"],
];

/** What survives a redraw: the open tab, the last result and the developer message, per provider. */
const held = { tab: {}, result: {}, message: {}, busy: {} };

const textFor = (provider) => PROVIDERS.find((p) => p.id === provider);
const redraw = () => document.dispatchEvent(new CustomEvent("costgrid:render"));

/** Step 2 is done once any usage has arrived, from a key or a file. */
export function connectDone(connect) {
  return Boolean(connect && (connect.hasImports || connect.sourceCount > 0));
}

// ------------------------------------------------------------- formatting

function formatDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(day);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const formatDate = (ms) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const range = (from, to) =>
  !from || !to ? "" : from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;
const rows = (n) => `${count(n)} ${n === 1 ? "row" : "rows"}`;

function resultBanner(result) {
  if (!result) return "";
  const tone = result.kind === "bad" ? "bad" : result.kind === "good" ? "good" : "";
  const lines = (result.lines ?? []).filter(Boolean).map((l) => `<p>${escapeHtml(l)}</p>`).join("");
  const list = result.list?.length
    ? `<ul>${result.list.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
    : "";
  return `<div class="banner ${tone} connect-banner"><strong>${escapeHtml(result.title)}</strong>${lines}${list}</div>`;
}

// ------------------------------------------------------------- the cards

/** What is connected now: the stored key, or the last import if there is no key. */
function connectionState(provider, entry, runs) {
  const key = entry?.adminKey;
  if (key) {
    const expired = key.expiresAt !== null && key.expiresAt <= Date.now();
    const expiry =
      key.expiresAt === null
        ? "No expiry date."
        : `${expired ? "Expired" : "CostGrid stops using it after"} ${formatDate(key.expiresAt)}.`;
    const sync =
      key.lastSyncAt === null
        ? "Not checked yet."
        : key.lastSyncStatus === "error"
          ? `Last check ${relativeTime(key.lastSyncAt)} failed: ${key.lastSyncError ?? "unknown error"}`
          : `Last checked ${relativeTime(key.lastSyncAt)}.`;
    return {
      tag: expired ? '<span class="tag block">Key expired</span>' : '<span class="tag on">Connected</span>',
      text: `Admin key ending ${key.hint.slice(-4)}. ${expiry} ${sync}`,
      forget: true,
    };
  }
  const last = runs.find((r) => r.provider === provider && r.status === "ok");
  if (last) {
    const how = last.origin === "csv" ? "Usage file imported" : "Imported with an admin key that was not kept";
    return {
      tag: '<span class="tag on">Imported</span>',
      text: `${how} ${relativeTime(last.finishedAt ?? last.startedAt)}, ${rows(last.rowsWritten)}.`,
    };
  }
  return { tag: '<span class="tag">Not connected</span>', text: "Not connected." };
}

function steps(list, link, linkText) {
  const items = list.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  return `<ol class="howto">${items}</ol>
    <p><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkText)}</a></p>`;
}

function adminPanel(p, secretStore) {
  const today = new Date().toISOString().slice(0, 10);
  const options = EXPIRY_OPTIONS.map(
    (o) => `<option value="${o.value}"${o.value === DEFAULT_EXPIRY ? " selected" : ""}>${escapeHtml(o.label)}</option>`,
  ).join("");
  return `<form class="connect-key-form" data-provider="${p.id}" autocomplete="off">
      ${steps(p.adminKey.steps, p.adminKey.url, p.adminKey.linkText)}
      <div class="banner"><strong>Before you start.</strong> ${escapeHtml(p.adminKey.warning)}</div>
      <figure class="shot-placeholder" aria-label="Screenshot: where to create the key">
        <div class="shot-frame" aria-hidden="true">Screenshot</div>
        <figcaption>${escapeHtml(p.adminKey.shotCaption)}</figcaption>
      </figure>
      ${field(COPY.keyLabel, "adminKey", "password", 'autocomplete="off" spellcheck="false" required')}
      <label class="field">
        <span class="field-label">${escapeHtml(COPY.expiryLabel)}</span>
        <select name="expiry" data-expiry>${options}</select>
      </label>
      <div data-expiry-date hidden>${field(COPY.dateLabel, "expiryDate", "date", `min="${today}"`)}</div>
      ${secretStore ? "" : `<p class="kpi-sub">${escapeHtml(COPY.noStore)}</p>`}
      ${button(COPY.connectButton, 'type="submit"')}
    </form>`;
}

function filePanel(p) {
  const input = `file-${p.id}`;
  return `<div class="dropzone" tabindex="0" data-dropzone data-provider="${p.id}"
        aria-label="${escapeHtml(`${p.short} usage file. Press Enter to choose a file.`)}">
        <p class="dropzone-title">${escapeHtml(COPY.dropTitle)}</p>
        <input type="file" accept=".csv,text/csv" id="${input}" class="visually-hidden" tabindex="-1"
          data-usage-file data-provider="${p.id}" />
        <label for="${input}" class="btn">${escapeHtml(COPY.chooseFile)}</label>
        <p class="dropzone-note">${escapeHtml(replacesNote(p.short))}</p>
      </div>
      ${steps(p.usageFile.steps, p.usageFile.url, p.usageFile.linkText)}
      <p class="kpi-sub">${escapeHtml(p.usageFile.who)}</p>`;
}

function developerPanel(p) {
  const message = held.message[p.id];
  let inner;
  if (!message) inner = '<p class="kpi-sub">Loading the message…</p>';
  else if (message.error) inner = `<div class="banner bad"><strong>${escapeHtml(message.error)}</strong></div>`;
  else {
    const mailto = `mailto:?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.body)}`;
    inner = `<label class="field">
        <span class="field-label">Subject</span>
        <input type="text" readonly value="${escapeHtml(message.subject)}" />
      </label>
      <label class="field">
        <span class="field-label">Message</span>
        <textarea class="dev-message" readonly rows="12" data-message-body="${p.id}">${escapeHtml(message.body)}</textarea>
      </label>
      <div class="form-row">
        ${button("Copy message", `type="button" data-copy-message data-provider="${p.id}"`, "secondary")}
        <a class="btn" href="${escapeHtml(mailto)}">Open in email</a>
        <span class="kpi-sub" aria-live="polite" data-copy-status="${p.id}"></span>
      </div>`;
  }
  return `<p class="kpi-sub">${escapeHtml(COPY.developerIntro)}</p>
    <div data-dev-message="${p.id}">${inner}</div>
    <div class="banner"><strong>Keep keys out of email.</strong> ${escapeHtml(COPY.developerNote)}</div>`;
}

function card(p, connect) {
  const entry = connect.providers?.find((e) => e.provider === p.id);
  const now = connectionState(p.id, entry, connect.runs ?? []);
  const open = held.tab[p.id] ?? "admin";
  if (open === "developer" && !held.message[p.id]) setTimeout(() => void loadMessage(p.id), 0);

  const tabs = TABS.map(
    ([id, label]) => `<button type="button" data-connect-tab="${id}" data-provider="${p.id}"
        aria-pressed="${id === open}" aria-controls="panel-${p.id}-${id}">${escapeHtml(label)}</button>`,
  ).join("");
  const panel = (id, body) =>
    `<div class="tab-panel" id="panel-${p.id}-${id}"${id === open ? "" : " hidden"}>${body}</div>`;

  return `<section class="card provider-card" aria-labelledby="provider-${p.id}">
    <div class="provider-card-head">
      <h3 id="provider-${p.id}">${escapeHtml(p.name)}</h3>${now.tag}
    </div>
    <p class="connection-state">${escapeHtml(now.text)}
      ${now.forget ? button("Forget this key", `type="button" data-action="forget-admin-key" data-provider="${p.id}"`, "quiet") : ""}</p>
    <div class="segmented connect-tabs" role="group" aria-label="${escapeHtml(`How to connect ${p.short}`)}">${tabs}</div>
    ${panel("admin", adminPanel(p, connect.secretStore))}
    ${panel("file", filePanel(p))}
    ${panel("developer", developerPanel(p))}
    <div class="connect-result" aria-live="polite" id="connect-result-${p.id}">${resultBanner(held.result[p.id])}</div>
  </section>`;
}

/** The body of step 2. `connect` is GET /console/:t/connect. */
export function renderConnect(connect) {
  return `<p class="section-note">${escapeHtml(COPY.stepIntro)}</p>
    <div class="provider-cards">${PROVIDERS.map((p) => card(p, connect)).join("")}</div>`;
}

// ------------------------------------------------------------- admin key

/** The expiry picker as epoch ms, or null for never. Throws a plain message if the date is unusable. */
function expiryFrom(form) {
  const choice = form.elements.expiry.value;
  if (choice === "never") return null;
  if (choice === "date") {
    const value = form.elements.expiryDate.value;
    const [y, m, d] = value.split("-").map(Number);
    if (!y || !m || !d) throw new Error("Choose the date CostGrid should stop using the key.");
    const end = new Date(y, m - 1, d, 23, 59, 59).getTime();
    if (end <= Date.now()) throw new Error("Choose a date in the future.");
    return end;
  }
  const option = EXPIRY_OPTIONS.find((o) => o.value === choice && o.ms);
  return Date.now() + (option ?? EXPIRY_OPTIONS.find((o) => o.value === DEFAULT_EXPIRY)).ms;
}

async function connectKey(form) {
  const provider = form.dataset.provider;
  const p = textFor(provider);
  const adminKey = String(form.elements.adminKey.value).trim();
  // Out of the page as soon as it has been read, whatever happens next.
  form.elements.adminKey.value = "";
  held.tab[provider] = "admin";
  if (!p) return;
  if (!adminKey) {
    held.result[provider] = { kind: "bad", title: "Paste the admin key first." };
    return;
  }
  let expiresAt;
  try {
    expiresAt = expiryFrom(form);
  } catch (error) {
    held.result[provider] = { kind: "bad", title: error.message };
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = COPY.connecting;
  }
  try {
    const r = await call("PUT", `/console/${state.tenantId}/connect/${provider}/admin-key`, { adminKey, expiresAt });
    const covers = range(r.fromDay, r.toDay);
    held.result[provider] = {
      kind: "good",
      title: `Imported ${rows(r.rowsWritten)} from ${p.short}${covers ? `, ${covers}` : ""}.`,
      lines: [
        r.stored ? (expiresAt === null ? COPY.storedNoExpiry : COPY.storedWithExpiry) : COPY.notStored,
        r.sources > 0 ? `Found ${count(r.sources)} keys, projects or workspaces. Name them in step 3.` : "",
        r.unpricedModels?.length
          ? `${r.unpricedModels.length} model(s) could not be priced: ${r.unpricedModels.join(", ")}.`
          : "",
      ],
    };
  } catch (error) {
    held.result[provider] = { kind: "bad", title: error.message };
  }
}

// ------------------------------------------------------------- usage file

async function postUsageFile(provider, body) {
  const response = await fetch(`/console/${state.tenantId}/connect/${provider}/usage-file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

async function uploadFile(provider, file) {
  const p = textFor(provider);
  if (!p || !file || held.busy[provider]) return;
  held.tab[provider] = "file";
  const region = document.getElementById(`connect-result-${provider}`);
  const show = (result) => {
    held.result[provider] = result;
    if (region) region.innerHTML = resultBanner(result);
  };

  if (file.size > MAX_FILE_BYTES) {
    show({ kind: "bad", title: `${file.name} is larger than 32 MB.`, lines: ["Export a shorter period and try again."] });
    return;
  }
  held.busy[provider] = true;
  try {
    show({ kind: "info", title: `Importing ${file.name}…`, lines: [replacesNote(p.short)] });
    const text = await file.text();
    const { ok, status, payload } = await postUsageFile(provider, { fileName: file.name, text });
    if (!ok) {
      const message = payload.error ?? `The file could not be imported (${status}).`;
      held.result[provider] = {
        kind: "bad",
        title: message,
        lines: [status === 400 && payload.code === "cost-file" ? p.usageFile.costFileHint : ""],
      };
    } else if (payload.rowsWritten === 0) {
      held.result[provider] = {
        kind: "good",
        title: payload.fromDay
          ? `The file covers ${range(payload.fromDay, payload.toDay)} and shows no usage in that period.`
          : "The file shows no usage.",
        list: payload.warnings ?? [],
      };
    } else {
      const covers = range(payload.fromDay, payload.toDay);
      held.result[provider] = {
        kind: "good",
        title: `Imported ${rows(payload.rowsWritten)} from ${file.name}.`,
        lines: [covers ? `Covers ${covers}.` : ""],
        list: payload.warnings ?? [],
      };
    }
  } catch (error) {
    held.result[provider] = { kind: "bad", title: `${file.name} could not be imported: ${error.message}` };
  } finally {
    held.busy[provider] = false;
  }
  redraw();
}

// ------------------------------------------------------------- developer message

async function loadMessage(provider) {
  if (held.message[provider]?.loading) return;
  held.message[provider] = { loading: true };
  try {
    const m = await call("GET", `/console/${state.tenantId}/connect/developer-message?provider=${provider}`);
    held.message[provider] = { subject: String(m.subject ?? ""), body: String(m.body ?? "") };
  } catch (error) {
    held.message[provider] = { error: `The message could not be loaded: ${error.message}` };
  }
  const box = document.querySelector(`[data-dev-message="${provider}"]`)?.closest(".tab-panel");
  const p = textFor(provider);
  if (box && p) box.innerHTML = developerPanel(p);
}

async function copyMessage(provider) {
  const area = document.querySelector(`[data-message-body="${provider}"]`);
  const status = document.querySelector(`[data-copy-status="${provider}"]`);
  if (!area) return;
  try {
    await navigator.clipboard.writeText(area.value);
    if (status) status.textContent = "Copied.";
  } catch {
    // No clipboard access: select it so a keyboard copy works.
    area.focus();
    area.select();
    if (status) status.textContent = "Selected. Press Cmd+C or Ctrl+C to copy.";
  }
}

// ------------------------------------------------------------- page listeners

function showTab(provider, tab) {
  held.tab[provider] = tab;
  for (const button of document.querySelectorAll(`[data-connect-tab][data-provider="${provider}"]`)) {
    const on = button.dataset.connectTab === tab;
    button.setAttribute("aria-pressed", String(on));
    const panel = document.getElementById(button.getAttribute("aria-controls"));
    if (panel) panel.hidden = !on;
  }
  if (tab === "developer" && !held.message[provider]) void loadMessage(provider);
}

const setupShown = () => state.user && state.page === "setup" && document.querySelector("[data-dropzone]");

function markOver(zone) {
  for (const z of document.querySelectorAll("[data-dropzone].is-over")) if (z !== zone) z.classList.remove("is-over");
  zone?.classList.add("is-over");
}

const zoneOf = (target) => (target instanceof Element ? target.closest("[data-dropzone]") : null);

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const tab = target?.closest("[data-connect-tab]");
  if (tab) return showTab(tab.dataset.provider, tab.dataset.connectTab);
  const copy = target?.closest("[data-copy-message]");
  if (copy) void copyMessage(copy.dataset.provider);
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.matches("[data-expiry]")) {
    const date = target.form?.querySelector("[data-expiry-date]");
    if (date) date.hidden = target.value !== "date";
  } else if (target.matches("[data-usage-file]")) {
    const file = target.files?.[0];
    target.value = "";
    void uploadFile(target.dataset.provider, file);
  }
});

document.addEventListener("keydown", (event) => {
  const zone = event.target instanceof Element && event.target.matches("[data-dropzone]") ? event.target : null;
  if (!zone || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  zone.querySelector("[data-usage-file]")?.click();
});

// One pair for the whole page, registered once. Off the setup page they do
// nothing; on it, a drop anywhere is swallowed so the window never navigates
// to the file, and only a drop on a card's zone is imported.
document.addEventListener("dragover", (event) => {
  if (!setupShown()) return;
  event.preventDefault();
  const zone = zoneOf(event.target);
  if (event.dataTransfer) event.dataTransfer.dropEffect = zone ? "copy" : "none";
  markOver(zone);
});

document.addEventListener("drop", (event) => {
  if (!setupShown()) return;
  event.preventDefault();
  markOver(null);
  const zone = zoneOf(event.target);
  const file = event.dataTransfer?.files?.[0];
  if (zone && file) void uploadFile(zone.dataset.provider, file);
});

// Leaving the window mid-drag: clear the highlight.
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) markOver(null);
});

// ------------------------------------------------------------- dispatch

export async function submit(form) {
  if (!form.classList.contains("connect-key-form")) return false;
  await connectKey(form);
  return true;
}

export async function click(target) {
  if (target.dataset.action !== "forget-admin-key") return false;
  const p = textFor(target.dataset.provider);
  if (!p) return true;
  await call("DELETE", `/console/${state.tenantId}/connect/${p.id}/admin-key`);
  delete held.result[p.id];
  state.flash = {
    kind: "ok",
    text: `CostGrid no longer keeps your ${p.short} admin key. The usage already imported stays.`,
  };
  return true;
}
