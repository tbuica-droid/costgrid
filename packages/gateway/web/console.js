/**
 * CostGrid console — signup, login, and organisation settings.
 *
 * Talks only to /console/*, which authenticates with a session cookie. The
 * dashboard at / is separate and uses an API key; keeping the two apart means
 * a browser session can never be used to spend tokens.
 *
 * A provider key is write-only from here: it can be set and replaced, never
 * read back. The server returns a masked tail and nothing else.
 */

const state = { user: null, orgs: [], tenantId: null, view: "settings", flash: null };

async function call(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `request failed (${response.status})`);
  return payload;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

const money = (decimalString) => `$${Number(decimalString).toFixed(2)}`;
const count = (n) => n.toLocaleString("en-US");

function relativeTime(timestamp) {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function field(label, name, type = "text", extra = "") {
  return `<label style="display:block;margin-bottom:14px">
    <span class="rail" style="display:block;margin-bottom:6px">${escapeHtml(label)}</span>
    <input name="${name}" type="${type}" ${extra}
      style="width:100%;max-width:420px;padding:9px 11px;border:1px solid var(--rule);
             background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px" />
  </label>`;
}

function button(text, attrs = "") {
  return `<button ${attrs}
    style="font-family:var(--mono);font-size:12px;letter-spacing:0.04em;padding:9px 16px;
           border:1px solid var(--ink);background:var(--ink);color:var(--bg);cursor:pointer">
    ${escapeHtml(text)}</button>`;
}

function flashBanner() {
  if (!state.flash) return "";
  const { kind, text } = state.flash;
  const colour = kind === "error" ? "var(--rust)" : "var(--green)";
  return `<div class="banner" style="border-color:${colour}"><strong style="color:${colour}">
    ${escapeHtml(text)}</strong></div>`;
}

// ------------------------------------------------------------- signed out

function renderAuth() {
  const signingUp = state.view === "signup";

  return `
    <div style="max-width:460px">
      <h2>${signingUp ? "Create an account" : "Sign in"}</h2>
      <p class="section-note">CostGrid meters and governs your LLM spend. You bring your own
        provider keys; they are encrypted before they touch disk and are never shown again.</p>
      ${flashBanner()}
      <form id="auth-form" class="card">
        ${signingUp ? field("Your name", "name") : ""}
        ${signingUp ? field("Organisation", "organisation") : ""}
        ${field("Email", "email", "email")}
        ${field("Password", "password", "password", signingUp ? 'minlength="12"' : "")}
        ${signingUp ? '<p class="kpi-sub" style="margin:-6px 0 14px">At least 12 characters.</p>' : ""}
        ${button(signingUp ? "Create account" : "Sign in", 'type="submit"')}
      </form>
      <p class="section-note" style="margin-top:18px">
        ${
          signingUp
            ? 'Already have an account? <a href="#" data-view="login">Sign in</a>.'
            : 'No account? <a href="#" data-view="signup">Create one</a>.'
        }
      </p>
    </div>`;
}

// -------------------------------------------------------------- signed in

async function renderSettings() {
  const tenantId = state.tenantId;
  const org = state.orgs.find((o) => o.tenantId === tenantId);

  const [credentials, keys, billing, importState] = await Promise.all([
    call("GET", `/console/${tenantId}/credentials`),
    call("GET", `/console/${tenantId}/keys`),
    call("GET", `/console/${tenantId}/billing`),
    call("GET", `/console/${tenantId}/import`),
  ]);

  const credentialRows = credentials.providers
    .map(
      (p) => `<tr>
        <td><strong>${escapeHtml(p.provider)}</strong><br />
          <span class="kpi-sub"><code>${escapeHtml(p.path)}</code></span></td>
        <td>${
          p.configured
            ? `<span class="tag on">configured</span> <code>${escapeHtml(p.hint)}</code>`
            : '<span class="tag off">not set</span>'
        }</td>
        <td class="num">
          <form class="cred-form" data-provider="${escapeHtml(p.provider)}"
                style="display:flex;gap:8px;justify-content:flex-end">
            <input name="apiKey" type="password" placeholder="${p.configured ? "Replace key" : "Paste key"}"
              autocomplete="off"
              style="padding:7px 10px;border:1px solid var(--rule);background:var(--bg);
                     color:var(--ink);font-family:var(--mono);font-size:12px;width:210px" />
            ${button("Save", 'type="submit"')}
            ${
              p.configured
                ? `<button type="button" data-remove="${escapeHtml(p.provider)}"
                     style="font-family:var(--mono);font-size:12px;padding:9px 12px;
                            border:1px solid var(--rule);background:transparent;
                            color:var(--rust);cursor:pointer">Remove</button>`
                : ""
            }
          </form>
        </td>
      </tr>`,
    )
    .join("");

  const keyRows = keys.keys.length
    ? keys.keys
        .map(
          (k) => `<tr>
            <td><strong>${escapeHtml(k.name)}</strong></td>
            <td><code>${escapeHtml(k.prefix)}…</code></td>
            <td>${k.revokedAt ? '<span class="tag off">revoked</span>' : '<span class="tag on">active</span>'}</td>
            <td class="num">${
              k.revokedAt
                ? "—"
                : `<button type="button" data-revoke="${escapeHtml(k.id)}"
                     style="font-family:var(--mono);font-size:11px;padding:5px 10px;
                            border:1px solid var(--rule);background:transparent;
                            color:var(--rust);cursor:pointer">Revoke</button>`
            }</td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="4" class="kpi-sub">No keys yet. Create one to start sending traffic.</td></tr>';

  const planOptions = billing.availablePlans
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === billing.plan.id ? "selected" : ""}>
           ${escapeHtml(p.name)} · ${money(p.monthlyBaseUsd)}/mo + ${p.spendFeeBps / 100}% of spend
         </option>`,
    )
    .join("");

  return `
    <h2>${escapeHtml(org?.tenantName ?? "Organisation")}</h2>
    <p class="section-note">Signed in as ${escapeHtml(state.user.email)}
      · <a href="/" >Open the dashboard</a>
      · <a href="#" id="logout">Sign out</a></p>
    ${flashBanner()}

    <h2 style="margin-top:26px">Provider credentials</h2>
    <p class="section-note">Your own API keys. CostGrid encrypts each one before storing it and
      presents it only to that provider. It is never returned to this page, and a database dump
      does not contain it. A provider with no key here serves no route for your organisation.</p>
    <div class="card scroll-x"><table>
      <thead><tr><th>Provider</th><th>Status</th><th class="num">Key</th></tr></thead>
      <tbody>${credentialRows}</tbody>
    </table></div>

    <h2 style="margin-top:26px">Import your history</h2>
    <p class="section-note">See your last 90 days before routing a single request. Paste an
      <strong>admin</strong> key and CostGrid reads your organisation's usage report straight from
      the provider. The key is used for this one request and <strong>never stored</strong>.</p>
    <p class="section-note">These are the provider's daily totals, not calls we watched, so
      there is no per-agent breakdown and nothing to enforce against. It is shown separately
      from metered spend for exactly that reason.</p>
    <div class="card">
      ${importState.providers
        .map(
          (p) => `<form class="import-form" data-provider="${escapeHtml(p.provider)}"
                        style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
            <span style="min-width:90px"><strong>${escapeHtml(p.provider)}</strong></span>
            <input name="adminKey" type="password" placeholder="Admin key" autocomplete="off"
              style="padding:8px 11px;border:1px solid var(--rule);background:var(--bg);
                     color:var(--ink);font-family:var(--mono);font-size:12px;width:260px" />
            <select name="days" style="padding:8px">
              <option value="30">30 days</option>
              <option value="90" selected>90 days</option>
              <option value="365">1 year</option>
            </select>
            ${button("Import", 'type="submit"')}
            <span class="kpi-sub" style="flex-basis:100%">${escapeHtml(p.keyHint)}</span>
          </form>`,
        )
        .join("")}
      ${
        importState.runs.length
          ? `<div class="scroll-x" style="margin-top:8px"><table>
               <thead><tr><th>When</th><th>Provider</th><th>Range</th><th>Rows</th><th>Status</th></tr></thead>
               <tbody>${importState.runs
                 .map(
                   (r) => `<tr>
                     <td>${relativeTime(r.startedAt)}</td>
                     <td>${escapeHtml(r.provider)}</td>
                     <td><code>${escapeHtml(r.fromDay)} → ${escapeHtml(r.toDay)}</code></td>
                     <td class="num">${count(r.rowsWritten)}</td>
                     <td><span class="tag ${r.status === "ok" ? "on" : r.status === "error" ? "block" : "monitor"}">${escapeHtml(r.status)}</span>
                       ${r.errorMessage ? `<br /><span class="kpi-sub">${escapeHtml(r.errorMessage)}</span>` : ""}</td>
                   </tr>`,
                 )
                 .join("")}</tbody></table></div>`
          : ""
      }
    </div>

    <h2 style="margin-top:26px">Gateway API keys</h2>
    <p class="section-note">What your services present to CostGrid, as the
      <code>x-costgrid-key</code> header. Shown once at creation.</p>
    <div class="card scroll-x"><table>
      <thead><tr><th>Name</th><th>Prefix</th><th>Status</th><th class="num"></th></tr></thead>
      <tbody>${keyRows}</tbody>
    </table></div>
    <form id="key-form" style="display:flex;gap:8px;margin-top:14px;align-items:center">
      <input name="name" placeholder="Key name, e.g. ci-pipeline"
        style="padding:9px 11px;border:1px solid var(--rule);background:var(--bg);
               color:var(--ink);font-family:var(--sans);font-size:14px;width:260px" />
      ${button("Create key", 'type="submit"')}
    </form>

    <h2 style="margin-top:26px">Plan and billing</h2>
    <p class="section-note">Two separate numbers: what your AI cost you, and what CostGrid
      charges for governing it. Billing is invoiced manually in this release. Changing the plan
      here records the intent, it does not charge a card.</p>
    <div class="grid cols-4">
      <div class="card">
        <div class="rail">Your AI spend</div>
        <div class="kpi-value">${money(billing.meteredSpendUsd)}</div>
        <div class="kpi-sub">last 30 days · ${count(billing.calls)} calls</div>
      </div>
      <div class="card">
        <div class="rail">Subscription</div>
        <div class="kpi-value">${money(billing.baseUsd)}</div>
        <div class="kpi-sub">${escapeHtml(billing.plan.name)} plan</div>
      </div>
      <div class="card">
        <div class="rail">Usage fee</div>
        <div class="kpi-value">${money(billing.spendFeeUsd)}</div>
        <div class="kpi-sub">${billing.plan.spendFeeBps / 100}% of metered spend</div>
      </div>
      <div class="card">
        <div class="rail">CostGrid total</div>
        <div class="kpi-value accent-gold">${money(billing.totalUsd)}</div>
        <div class="kpi-sub">${
          billing.withinAllowance
            ? `within ${count(billing.plan.includedCallsPerMonth)} included calls`
            : `<span class="accent-rust">${count(billing.overageCalls)} calls over allowance</span>`
        }</div>
      </div>
    </div>
    <form id="plan-form" style="display:flex;gap:8px;margin-top:14px;align-items:center">
      <select name="plan" style="padding:9px 11px;min-width:340px">${planOptions}</select>
      ${button("Change plan", 'type="submit"')}
    </form>
    <p class="section-note" style="margin-top:10px">Rate limit on this plan:
      ${count(billing.plan.rateLimitPerMinute)} requests/minute.</p>`;
}

// ------------------------------------------------------------------- shell

function renderNav() {
  const nav = document.getElementById("nav");
  if (!state.user) {
    nav.innerHTML = "";
    return;
  }
  nav.innerHTML = state.orgs
    .map(
      (o) =>
        `<button data-tenant="${escapeHtml(o.tenantId)}"
           aria-current="${o.tenantId === state.tenantId}">${escapeHtml(o.tenantName)}</button>`,
    )
    .join("");
}

async function render() {
  const main = document.getElementById("main");
  try {
    main.innerHTML = state.user ? await renderSettings() : renderAuth();
    document.getElementById("footer-note").textContent = state.user
      ? `${state.orgs.length} organisation${state.orgs.length === 1 ? "" : "s"}`
      : "";
  } catch (error) {
    main.innerHTML = `<div class="banner"><strong>${escapeHtml(error.message)}</strong></div>`;
  }
  renderNav();
  state.flash = null;
}

async function loadSession() {
  try {
    const me = await call("GET", "/console/me");
    state.user = me.user;
    state.orgs = me.organisations;
    state.tenantId = me.organisations[0]?.tenantId ?? null;
  } catch {
    state.user = null;
  }
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

document.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();

  try {
    if (form.id === "auth-form") {
      const values = formValues(form);
      await call("POST", state.view === "signup" ? "/console/signup" : "/console/login", values);
      await loadSession();
    } else if (form.id === "key-form") {
      const { name } = formValues(form);
      const created = await call("POST", `/console/${state.tenantId}/keys`, { name });
      // Shown once and never again — make that unmissable.
      state.flash = { kind: "ok", text: `Key created. Copy it now, it is not shown again: ${created.key}` };
    } else if (form.id === "plan-form") {
      const { plan } = formValues(form);
      await call("PUT", `/console/${state.tenantId}/plan`, { plan });
      state.flash = { kind: "ok", text: "Plan updated." };
    } else if (form.classList.contains("import-form")) {
      const { adminKey, days } = formValues(form);
      if (!adminKey) return;
      const result = await call("POST", `/console/${state.tenantId}/import/${form.dataset.provider}`, {
        adminKey,
        days: Number(days),
      });
      const unpriced = result.unpricedModels.length
        ? ` ${result.unpricedModels.length} model(s) could not be priced: ${result.unpricedModels.join(", ")}.`
        : "";
      state.flash = {
        kind: "ok",
        text: `Imported ${result.rowsWritten} day/model rows from ${result.provider}.${unpriced}`,
      };
    } else if (form.classList.contains("cred-form")) {
      const { apiKey } = formValues(form);
      if (!apiKey) return;
      await call("PUT", `/console/${state.tenantId}/credentials/${form.dataset.provider}`, { apiKey });
      state.flash = { kind: "ok", text: `${form.dataset.provider} credential saved.` };
    } else {
      return;
    }
  } catch (error) {
    state.flash = { kind: "error", text: error.message };
  }
  await render();
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-view], [data-tenant], [data-remove], [data-revoke], #logout");
  if (!target) return;
  event.preventDefault();

  try {
    if (target.dataset.view) {
      state.view = target.dataset.view;
    } else if (target.dataset.tenant) {
      state.tenantId = target.dataset.tenant;
    } else if (target.dataset.remove) {
      await call("DELETE", `/console/${state.tenantId}/credentials/${target.dataset.remove}`);
      state.flash = { kind: "ok", text: "Credential removed." };
    } else if (target.dataset.revoke) {
      await call("DELETE", `/console/${state.tenantId}/keys/${target.dataset.revoke}`);
      state.flash = { kind: "ok", text: "Key revoked." };
    } else if (target.id === "logout") {
      await call("POST", "/console/logout");
      state.user = null;
      state.view = "login";
    }
  } catch (error) {
    state.flash = { kind: "error", text: error.message };
  }
  await render();
});

await loadSession();
await render();
