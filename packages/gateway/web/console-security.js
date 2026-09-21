import { button, count, escapeHtml, field } from "./ui.js";

/**
 * The three parts of the console a security review asks about: company
 * sign-in, how long data is kept, and the record of who changed what.
 *
 * Written for whoever has to answer the questionnaire rather than for whoever
 * set the identity provider up. Every sentence here is about what the setting
 * does to people, not about the protocol underneath it.
 */

export function ssoSection(sso) {
  const c = sso.connection;
  return `<div class="card">
    <p class="section-note" style="margin-top:0">Give this address to your identity provider as
      the redirect or callback URL. It has to match exactly.</p>
    <p><code>${escapeHtml(sso.redirectUri)}</code></p>
    ${
      c
        ? `<p style="margin-top:14px"><span class="tag ${c.enabled ? "on" : "off"}">${
            c.enabled ? "active" : "switched off"
          }</span>
           ${c.enforced ? '<span class="tag block">passwords refused</span>' : ""}
           &nbsp;<code>${escapeHtml(c.issuer)}</code></p>
         <p class="kpi-sub">Covers ${escapeHtml(c.emailDomains.join(", "))}.
           ${
             c.enforced
               ? "Anyone with one of those addresses must use company sign-in. A CostGrid password will not let them in, even the right one."
               : "People with one of those addresses can use company sign-in, and can still use a password."
           }</p>`
        : '<p style="margin-top:14px"><span class="tag off">not set up</span></p>'
    }
    <form id="sso-form" style="margin-top:14px;display:grid;gap:8px;max-width:560px">
      ${field("Issuer URL", "issuer", "url", `value="${escapeHtml(c?.issuer ?? "")}" placeholder="https://login.microsoftonline.com/<id>/v2.0"`)}
      ${field("Application (client) ID", "clientId", "text", `value="${escapeHtml(c?.clientId ?? "")}"`)}
      ${field("Client secret", "clientSecret", "password", 'autocomplete="off" placeholder="Paste it again to change it"')}
      ${field("Email domains", "emailDomains", "text", `value="${escapeHtml((c?.emailDomains ?? []).join(", "))}" placeholder="acme.com, acme.co.uk"`)}
      <label style="font-size:13px"><input type="checkbox" name="enforced" ${c?.enforced ? "checked" : ""} />
        Require it: refuse CostGrid passwords for those domains</label>
      ${button("Save company sign-in", 'type="submit"')}
      <span class="kpi-sub">We look up the technical details from the issuer URL, so that
        and the client ID are usually all you need from your IT team.</span>
    </form>
  </div>`;
}

export function retentionSection(retention) {
  const say = (days) => (days === 0 ? "kept for good" : `${count(days)} days`);
  return `<div class="card">
    <div class="grid cols-4">
      <div><div class="rail">Detail of every call</div>
        <div class="kpi-value">${say(retention.callDays)}</div></div>
      <div><div class="rail">Record of rules firing</div>
        <div class="kpi-value">${say(retention.eventDays)}</div></div>
      <div><div class="rail">Record of changes</div>
        <div class="kpi-value">${say(retention.auditDays)}</div></div>
    </div>
    <form id="retention-form" style="margin-top:14px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      ${field("Call detail (days)", "callDays", "number", `value="${retention.callDays}" min="0"`)}
      ${field("Rule firings (days)", "eventDays", "number", `value="${retention.eventDays}" min="0"`)}
      ${button("Save", 'type="submit"')}
    </form>
    <p class="kpi-sub" style="margin-top:10px">Zero means keep for good. The record of changes is
      never deleted on a schedule, whatever is set here: a timer that erases the evidence looks
      exactly like someone erasing the evidence. Removing it takes a deliberate command run on
      the server.</p>
  </div>`;
}

export function auditSection(audit) {
  return `<div class="card">
    <p style="margin-top:0"><span class="tag ${audit.intact ? "on" : "block"}">${
      audit.intact ? "nothing has been altered" : "check failed"
    }</span></p>
    <p>${escapeHtml(audit.summary)}</p>
    <p class="kpi-sub" style="margin-top:12px">Fingerprint of the whole record:</p>
    <p><code style="word-break:break-all">${escapeHtml(audit.head)}</code></p>
    <p class="kpi-sub">Keep a copy of that somewhere outside CostGrid, such as an email to
      whoever is responsible for your audit. It stands for everything recorded up to now, so if
      any of it is ever changed you can show that it was.</p>
  </div>`;
}
