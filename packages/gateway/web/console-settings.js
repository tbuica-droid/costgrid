/**
 * The settings screen: appearance, provider keys, imported history, gateway
 * keys, plan, company sign-in, retention and the record of changes.
 *
 * Moved here unchanged from the console's main file when the console grew
 * other screens. The forms it renders are still handled there, and so is the
 * appearance switch, which is stored in this browser rather than on the server.
 */

import { call, flashBanner, state } from "./console-api.js";
import { auditSection, retentionSection, ssoSection } from "./console-security.js";
import { button, count, escapeHtml, getAppearance, money, pageHead, relativeTime } from "./ui.js";

const APPEARANCES = [
  ["dark", "Dark"],
  ["light", "Light"],
  ["system", "Match system"],
];

function appearanceSection() {
  const current = getAppearance();
  return `<div class="card">
    <div class="segmented" role="group" aria-label="Appearance">${APPEARANCES.map(
      ([value, label]) =>
        `<button type="button" data-appearance="${value}" aria-pressed="${value === current}">${label}</button>`,
    ).join("")}</div>
    <p class="kpi-sub" style="margin:10px 0 0">Saved on this computer only. Match system follows your
      operating system's light or dark setting.</p>
  </div>`;
}

export async function renderSettings() {
  const tenantId = state.tenantId;
  const org = state.orgs.find((o) => o.tenantId === tenantId);

  const [credentials, keys, billing, importState, sso, retention, audit] = await Promise.all([
    call("GET", `/console/${tenantId}/credentials`),
    call("GET", `/console/${tenantId}/keys`),
    call("GET", `/console/${tenantId}/billing`),
    call("GET", `/console/${tenantId}/import`),
    call("GET", `/console/${tenantId}/sso`),
    call("GET", `/console/${tenantId}/retention`),
    call("GET", `/console/${tenantId}/audit/verify`),
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
          <form class="cred-form form-row" data-provider="${escapeHtml(p.provider)}"
                style="justify-content:flex-end;flex-wrap:nowrap">
            <input name="apiKey" type="password" placeholder="${p.configured ? "Replace key" : "Paste key"}"
              autocomplete="off" class="w-key" />
            ${button("Save", 'type="submit"')}
            ${
              p.configured
                ? `<button type="button" class="btn btn-danger" data-remove="${escapeHtml(p.provider)}">Remove</button>`
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
                : `<button type="button" class="btn btn-sm btn-danger" data-revoke="${escapeHtml(k.id)}">Revoke</button>`
            }</td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="4" class="kpi-sub">No keys yet. Create one to start sending traffic.</td></tr>';

  const planOptions = billing.availablePlans
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === billing.plan.id ? "selected" : ""}>
           ${escapeHtml(p.name)} · ${money(p.monthlyBaseUsd)}/month, unlimited calls
         </option>`,
    )
    .join("");

  return `
    ${pageHead(
      org?.tenantName ?? "Organisation",
      `Signed in as ${escapeHtml(state.user.email)}`,
      '<a href="/" class="btn">Open the dashboard</a><a href="#" id="logout" class="btn btn-quiet">Sign out</a>',
    )}
    ${flashBanner()}

    <h2>Appearance</h2>
    ${appearanceSection()}

    <h2>Provider credentials</h2>
    <p class="section-note">Your own API keys. CostGrid encrypts each one before storing it and
      presents it only to that provider. It is never returned to this page, and a database dump
      does not contain it. A provider with no key here serves no route for your organisation.</p>
    <div class="card scroll-x"><table>
      <thead><tr><th>Provider</th><th>Status</th><th class="num">Key</th></tr></thead>
      <tbody>${credentialRows}</tbody>
    </table></div>

    <h2>Import your history</h2>
    <p class="section-note">See your last 90 days before routing a single request. Paste an
      <strong>admin</strong> key and CostGrid reads your organisation's usage report straight from
      the provider. The key is used for this one request and <strong>never stored</strong>.</p>
    <p class="section-note">These are the provider's daily totals, not calls we watched, so
      there is no per-agent breakdown and nothing to enforce against. It is shown separately
      from metered spend for exactly that reason.</p>
    <div class="card">
      ${importState.providers
        .map(
          (p) => `<form class="import-form form-row" data-provider="${escapeHtml(p.provider)}">
            <span class="provider">${escapeHtml(p.provider)}</span>
            <input name="adminKey" type="password" placeholder="Admin key" autocomplete="off" class="w-key" />
            <select name="days" aria-label="How far back">
              <option value="30">30 days</option>
              <option value="90" selected>90 days</option>
              <option value="365">1 year</option>
            </select>
            ${button("Import", 'type="submit"')}
            <span class="kpi-sub note">${escapeHtml(p.keyHint)}</span>
          </form>`,
        )
        .join("")}
      ${
        importState.runs.length
          ? `<div class="scroll-x" style="margin-top:16px"><table>
               <thead><tr><th>When</th><th>Provider</th><th>Range</th><th class="num">Rows</th><th>Status</th></tr></thead>
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

    <h2>Gateway API keys</h2>
    <p class="section-note">What your services present to CostGrid, as the
      <code>x-costgrid-key</code> header. Shown once at creation.</p>
    <div class="card scroll-x"><table>
      <thead><tr><th>Name</th><th>Prefix</th><th>Status</th><th class="num"></th></tr></thead>
      <tbody>${keyRows}</tbody>
    </table></div>
    <form id="key-form" class="form-row" style="margin-top:14px">
      <input name="name" placeholder="Key name, e.g. ci-pipeline" aria-label="Key name" class="w-key" />
      ${button("Create key", 'type="submit"')}
    </form>

    <h2>Plan and billing</h2>
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
        <div class="rail">Your plan</div>
        <div class="kpi-value">${escapeHtml(billing.plan.name)}</div>
        <div class="kpi-sub">unlimited calls and seats</div>
      </div>
      <div class="card">
        <div class="rail">What CostGrid costs</div>
        <div class="kpi-value accent-gold">${money(billing.totalUsd)}</div>
        <div class="kpi-sub">flat, every month</div>
      </div>
      <div class="card">
        <div class="rail">Fee on your AI bill</div>
        <div class="kpi-value">None</div>
        <div class="kpi-sub">this product exists to shrink that bill</div>
      </div>
    </div>
    <form id="plan-form" class="form-row" style="margin-top:14px">
      <select name="plan" class="w-wide" aria-label="Plan">${planOptions}</select>
      ${button("Change plan", 'type="submit"', "secondary")}
    </form>
    <p class="section-note" style="margin-top:10px">Rate limit on this plan:
      ${count(billing.plan.rateLimitPerMinute)} requests/minute.</p>

    <h2>Company sign-in</h2>
    <p class="section-note">Let people sign in with your company account instead of a CostGrid
      password. Works with Microsoft, Okta, Google Workspace and anything else that speaks
      OpenID Connect. Your identity provider decides who gets in, and we check that its answer
      is genuine before trusting it.</p>
    ${ssoSection(sso)}

    <h2>How long we keep your data</h2>
    <p class="section-note">Nothing is deleted unless you ask for it. Set a limit here and
      CostGrid removes anything older once a day. Deleted data is gone from every report,
      including months you have already sent out, so pick a window you can live with.</p>
    ${retentionSection(retention)}

    <h2>Record of changes</h2>
    <p class="section-note">Every change someone makes is written down: who added a key, who
      changed a budget, who signed in. Each entry is locked to the one before it, so an entry
      cannot be altered or removed without this check failing.</p>
    ${auditSection(audit)}`;
}
