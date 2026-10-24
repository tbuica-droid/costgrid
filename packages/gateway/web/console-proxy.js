/**
 * Advanced setup, as five steps: a provider key, a test of it, a gateway key,
 * the one change to make in your software, and the first call arriving.
 *
 * This is the developer route: traffic goes through CostGrid, so every call is
 * metered and limits can be enforced. It sits under "Advanced" on the setup
 * page, below the three steps an owner needs (console-wizard.js).
 *
 * Every step reads its state from the server, so the page is right after a
 * reload and after doing the same thing on the settings screen. The only
 * things kept here are a test result and a freshly created key, both of which
 * exist only for the moment they are shown.
 */

import { call, formValues, state } from "./console-api.js";
import { button, count, escapeHtml, money } from "./ui.js";

const held = { preflight: {}, newKey: null, newKeyName: null };
let poll = null;

/** True until the organisation has a provider key and a gateway key. */
export async function proxyNeedsSetup(tenantId) {
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
  return `<div class="card" style="margin-bottom:12px">
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <span class="step-label">Step ${n}</span>
      <h3 style="margin:0">${escapeHtml(title)}</h3>${tag}
    </div>
    <div style="margin-top:12px">${body}</div>
  </div>`;
}

const input = (name, placeholder, type = "text") =>
  `<input name="${name}" type="${type}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"
     aria-label="${escapeHtml(placeholder)}" class="w-key" />`;

function providerKeys(providers) {
  return providers
    .map(
      (p) => `<form class="wizard-cred-form form-row" data-provider="${escapeHtml(p.provider)}">
        <span class="provider">${escapeHtml(p.provider)}</span>
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
  const pre = (text) => `<pre class="code-block">${text}</pre>`;
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

/** The five step cards, without a page header: the setup page places them. */
export async function renderSteps() {
  const t = state.tenantId;
  const overviewUrl = `/api/overview?days=1&tenant=${encodeURIComponent(t)}`;
  const [credentials, keys, overview] = await Promise.all([
    call("GET", `/console/${t}/credentials`),
    call("GET", `/console/${t}/keys`),
    call("GET", overviewUrl),
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
          ? `<div class="banner good"><strong>
               Key "${escapeHtml(held.newKeyName)}" created. Copy it now, it is not shown again:</strong>
               <code class="key">${escapeHtml(held.newKey)}</code></div>`
          : ""
      }
      <form id="wizard-key-form" class="form-row">
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
  return false;
}

export async function click(target) {
  if (target.dataset.action !== "preflight") return false;
  const provider = target.dataset.provider;
  held.preflight[provider] = await call("POST", `/console/${state.tenantId}/preflight/${provider}`, {});
  return true;
}
