/**
 * Setup, as five steps: a provider key, a test of it, a gateway key, the one
 * change to make in your software, and the first call arriving.
 *
 * Every step reads its state from the server, so the page is right after a
 * reload and after doing the same thing on the settings screen. The only
 * things kept here are a test result and a freshly created key, both of which
 * exist only for the moment they are shown.
 */

import { call, flashBanner, formValues, state } from "./console-api.js";
import { button, count, escapeHtml, money } from "./ui.js";

const held = { preflight: {}, newKey: null, newKeyName: null };
let poll = null;

/** True until the organisation has a provider key and a gateway key. */
export async function needsSetup(tenantId) {
  const [credentials, keys] = await Promise.all([
    call("GET", `/console/${tenantId}/credentials`),
    call("GET", `/console/${tenantId}/keys`),
  ]);
  return !credentials.providers.some((p) => p.configured) || !keys.keys.some((k) => !k.revokedAt);
}

function step(n, title, status, body) {
  const tag =
    status === "done"
      ? '<span class="tag on">done</span>'
      : status === "next"
        ? '<span class="tag warn">next</span>'
        : '<span class="tag off">later</span>';
  return `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap">
      <span class="rail">Step ${n}</span>
      <h3 style="margin:0;font-size:16px">${escapeHtml(title)}</h3>${tag}
    </div>
    <div style="margin-top:12px">${body}</div>
  </div>`;
}

const input = (name, placeholder, type = "text") =>
  `<input name="${name}" type="${type}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"
     style="padding:8px 11px;border:1px solid var(--rule);background:var(--bg);color:var(--ink);
            font-family:var(--mono);font-size:12px;width:260px" />`;

function providerKeys(providers) {
  return providers
    .map(
      (p) => `<form class="wizard-cred-form" data-provider="${escapeHtml(p.provider)}"
                style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <span style="min-width:90px"><strong>${escapeHtml(p.provider)}</strong></span>
        ${
          p.configured
            ? `<span class="tag on">saved</span> <code>${escapeHtml(p.hint)}</code>`
            : '<span class="tag off">not set</span>'
        }
        ${input("apiKey", p.configured ? "Replace key" : "Paste key", "password")}
        ${button("Save", 'type="submit"')}
      </form>`,
    )
    .join("");
}

function preflightResult(provider) {
  const result = held.preflight[provider];
  if (!result) return "";
  const rows = result.steps
    .map(
      (s) => `<tr>
        <td><span class="tag ${s.ok ? "on" : "block"}">${s.ok ? "pass" : "fail"}</span></td>
        <td><code>${escapeHtml(s.name)}</code></td>
        <td style="white-space:normal">${escapeHtml(s.detail)}</td>
      </tr>`,
    )
    .join("");
  return `<div class="scroll-x" style="margin:8px 0 14px"><table><tbody>${rows}</tbody></table></div>
    <p class="kpi-sub">${
      result.ok
        ? "Everything this channel needs is working against your account."
        : "Something is wrong. If the failing stage is usage or route, that is a bug in CostGrid rather than in your setup."
    }</p>`;
}

function snippets(providers, key) {
  const origin = location.origin;
  const k = escapeHtml(key);
  const pre = (text) =>
    `<pre style="margin:6px 0 14px;padding:12px;border:1px solid var(--rule);overflow-x:auto;font-size:12px">${text}</pre>`;
  const out = [];
  if (providers.includes("anthropic")) {
    out.push(
      `<p><strong>Anthropic</strong>. Two settings, in code or as environment variables.</p>`,
      pre(`# Python\nclient = Anthropic(base_url="${origin}", api_key="${k}")\n\n# TypeScript\nconst client = new Anthropic({ baseURL: "${origin}", apiKey: "${k}" });\n\n# or in the environment\nANTHROPIC_BASE_URL=${origin}\nANTHROPIC_API_KEY=${k}`),
    );
  }
  if (providers.includes("openai")) {
    out.push(
      `<p><strong>OpenAI</strong>. The address ends in <code>/v1</code>, the way the SDK expects.</p>`,
      pre(`# Python\nclient = OpenAI(base_url="${origin}/v1", api_key="${k}")\n\n# or in the environment\nOPENAI_BASE_URL=${origin}/v1\nOPENAI_API_KEY=${k}`),
    );
  }
  if (providers.includes("bedrock") || providers.includes("vertex")) {
    out.push(
      `<p><strong>Bedrock and Vertex</strong>. Point the client at <code>${escapeHtml(origin)}</code>
        and send the key as the <code>x-costgrid-key</code> header on every request.</p>`,
    );
  }
  return out.join("");
}

/**
 * The trial path: real spend today, before any software is changed.
 *
 * An admin key reads the provider's own usage report for the last 90 days.
 * It is used for that one request and never stored. What comes back is the
 * provider's daily totals, not calls we watched, so it is shown apart from
 * metered spend and nothing can be enforced on it.
 */
function trialSection(importState, history, tenant) {
  const forms = importState.providers
    .map(
      (p) => `<form class="wizard-import-form" data-provider="${escapeHtml(p.provider)}"
                style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <span style="min-width:90px"><strong>${escapeHtml(p.provider)}</strong></span>
        ${input("adminKey", "Admin key", "password")}
        <select name="days" style="padding:8px">
          <option value="30">30 days</option>
          <option value="90" selected>90 days</option>
          <option value="365">1 year</option>
        </select>
        ${button("Show my spend", 'type="submit"')}
        <span class="kpi-sub" style="flex-basis:100%">${escapeHtml(p.keyHint)}</span>
      </form>`,
    )
    .join("");

  const seen = history.present
    ? `<p style="margin:0 0 12px"><strong>Your last ${history.days} days: ${money(history.effectiveCostUsd)}</strong>${
        history.requests ? ` across ${count(history.requests)} requests` : ""
      }, as reported by the provider.
       <a href="/?tenant=${encodeURIComponent(tenant)}">Open the dashboard</a> to see it by day and by model.</p>`
    : "";

  return `<div class="card sunk" style="margin-bottom:22px">
    <div style="display:flex;gap:12px;align-items:baseline;flex-wrap:wrap">
      <span class="rail">Before you change anything</span>
      <h3 style="margin:0;font-size:16px">See your real spend now</h3>
      ${history.present ? '<span class="tag on">imported</span>' : ""}
    </div>
    <p class="kpi-sub" style="margin:10px 0 12px">Paste an <strong>admin</strong> key and CostGrid reads
      your organisation's usage report straight from the provider: what you spent, by day and by
      model, for the last 90 days. The key is used for this one request and never stored. Nothing in
      your software changes.</p>
    ${seen}
    ${forms}
  </div>`;
}

export async function render() {
  const t = state.tenantId;
  const overviewUrl = `/api/overview?days=1&tenant=${encodeURIComponent(t)}`;
  const [credentials, keys, overview, importState, history] = await Promise.all([
    call("GET", `/console/${t}/credentials`),
    call("GET", `/console/${t}/keys`),
    call("GET", overviewUrl),
    call("GET", `/console/${t}/import`),
    call("GET", `/api/history?days=90&tenant=${encodeURIComponent(t)}`),
  ]);

  const configured = credentials.providers.filter((p) => p.configured).map((p) => p.provider);
  const activeKeys = keys.keys.filter((k) => !k.revokedAt);
  const seen = overview.calls > 0;
  const tested = configured.some((p) => held.preflight[p]?.ok);

  const done = [configured.length > 0, tested || seen, activeKeys.length > 0, seen, seen];
  const next = done.indexOf(false);
  const status = (i) => (done[i] ? "done" : i === next ? "next" : "later");

  if (!seen) watchForFirstCall(overviewUrl);

  const keyValue = held.newKey ?? "cg_live_…";
  return `
    <h2>Set up CostGrid</h2>
    <p class="section-note">Five steps from nothing to a real number. Each one is checked against
      what is actually saved, so you can leave and come back.</p>
    ${flashBanner()}
    ${trialSection(importState, history, t)}

    ${step(1, "Add your provider key", status(0), `
      <p class="kpi-sub" style="margin-bottom:12px">The key you already use with the provider. It is
        encrypted before it is stored and is never shown again, not even to you.</p>
      ${providerKeys(credentials.providers)}`)}

    ${step(2, "Test it", status(1), configured.length === 0
      ? '<p class="kpi-sub">Add a provider key first.</p>'
      : `<p class="kpi-sub" style="margin-bottom:12px">One real call on the cheapest model, a
           fraction of a cent, reporting exactly which stage failed if one does.</p>
         ${configured
           .map(
             (p) => `<div style="margin-bottom:8px">${button(`Test ${p}`, `type="button" data-action="preflight" data-provider="${escapeHtml(p)}"`)}</div>
               ${preflightResult(p)}`,
           )
           .join("")}`)}

    ${step(3, "Create a gateway key", status(2), `
      <p class="kpi-sub" style="margin-bottom:12px">What your software presents to CostGrid. One per
        service or bot, so spend is attributed to the right one. Shown once, at creation.</p>
      ${
        activeKeys.length
          ? `<p style="margin-bottom:10px">${activeKeys
              .map((k) => `<span class="tag on">${escapeHtml(k.name)}</span> <code>${escapeHtml(k.prefix)}…</code>`)
              .join(" &nbsp; ")}</p>`
          : ""
      }
      ${
        held.newKey
          ? `<div class="banner" style="border-color:var(--green)"><strong style="color:var(--green)">
               Key "${escapeHtml(held.newKeyName)}" created. Copy it now, it is not shown again:</strong>
               <code style="word-break:break-all;display:block;margin-top:6px">${escapeHtml(held.newKey)}</code></div>`
          : ""
      }
      <form id="wizard-key-form" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${input("name", "Key name, e.g. my-app")}
        ${button("Create key", 'type="submit"')}
      </form>`)}

    ${step(4, "Point your software at CostGrid", status(3), configured.length === 0
      ? '<p class="kpi-sub">Add a provider key first.</p>'
      : `<p class="kpi-sub" style="margin-bottom:12px">One change: the address the client sends to,
           plus your gateway key in place of the provider key. Nothing else in your code moves.
           ${held.newKey ? "" : "Use the key you copied in step 3."}</p>
         ${snippets(configured, keyValue)}`)}

    ${step(5, "See the first call arrive", status(4), seen
      ? `<p>Metered <strong>${count(overview.calls)}</strong> call${overview.calls === 1 ? "" : "s"} in the
           last 24 hours, <strong>${money(overview.totalCostUsd)}</strong>.
           <a href="/">Open the dashboard</a>.</p>`
      : `<p class="kpi-sub">Waiting for the first call. This page checks every few seconds; make a
           request from your software and it will show up here.</p>`)}`;
}

/** Re-render the moment the first call lands, while this screen is open. */
function watchForFirstCall(overviewUrl) {
  if (poll) clearInterval(poll);
  poll = setInterval(async () => {
    if (state.page !== "setup" || !state.user) {
      clearInterval(poll);
      poll = null;
      return;
    }
    const overview = await call("GET", overviewUrl).catch(() => null);
    if (overview && overview.calls > 0) {
      clearInterval(poll);
      poll = null;
      document.dispatchEvent(new CustomEvent("costgrid:render"));
    }
  }, 5000);
}

export async function submit(form) {
  const t = state.tenantId;
  if (form.classList.contains("wizard-cred-form")) {
    const { apiKey } = formValues(form);
    if (!apiKey) return true;
    await call("PUT", `/console/${t}/credentials/${form.dataset.provider}`, { apiKey });
    delete held.preflight[form.dataset.provider];
    state.flash = { kind: "ok", text: `${form.dataset.provider} key saved. Now test it.` };
    return true;
  }
  if (form.id === "wizard-key-form") {
    const name = String(formValues(form).name || "").trim();
    if (!name) return true;
    const created = await call("POST", `/console/${t}/keys`, { name });
    held.newKey = created.key;
    held.newKeyName = name;
    return true;
  }
  if (form.classList.contains("wizard-import-form")) {
    const { adminKey, days } = formValues(form);
    if (!adminKey) return true;
    const result = await call("POST", `/console/${t}/import/${form.dataset.provider}`, {
      adminKey,
      days: Number(days),
    });
    const unpriced = result.unpricedModels.length
      ? ` ${result.unpricedModels.length} model(s) could not be priced: ${result.unpricedModels.join(", ")}.`
      : "";
    state.flash = {
      kind: "ok",
      text: `Imported ${result.rowsWritten} day/model rows from ${result.provider}. The admin key was not kept.${unpriced}`,
    };
    return true;
  }
  return false;
}

export async function click(target) {
  if (target.dataset.action !== "preflight") return false;
  const provider = target.dataset.provider;
  held.preflight[provider] = await call("POST", `/console/${state.tenantId}/preflight/${provider}`, {});
  return true;
}
