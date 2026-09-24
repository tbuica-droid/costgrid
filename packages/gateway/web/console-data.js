/**
 * Data: a copy of everything, proof it has not been edited, and deleting it.
 *
 * Written for the person answering a security questionnaire or a deletion
 * request. Every action here says what it does to the data in a sentence,
 * and the one that cannot be undone asks for the organisation's name back.
 */

import { call, flashBanner, formValues, loadSession, loadSetup, state } from "./console-api.js";
import { button, count, escapeHtml, field, relativeTime } from "./ui.js";

function backupSection(desktop, tenantId) {
  if (!desktop) {
    return `<div class="card"><p style="margin:0">On a shared deployment, backups are taken by whoever
      runs the server, with <code>costgrid backup &lt;path&gt;</code>. The file would hold every
      organisation's data, not only yours.</p></div>`;
  }
  return `<div class="card">
    <p style="margin:0 0 12px">A consistent copy of everything CostGrid has recorded on this computer,
      safe to take while it is running. Provider keys inside it stay encrypted; without the master key
      in your keychain they cannot be read.</p>
    <a href="/console/${escapeHtml(tenantId)}/backup" download
       style="display:inline-block;font-family:var(--mono);font-size:12px;letter-spacing:0.04em;
              padding:9px 16px;border:1px solid var(--ink);background:var(--ink);color:var(--bg);
              text-decoration:none">Download a backup</a>
  </div>`;
}

function anchorsSection(a, desktop) {
  if (!a.configured) {
    return `<div class="card">
      <p style="margin:0"><span class="tag off">not sending</span></p>
      <p style="margin-top:10px">${
        desktop
          ? "The fingerprint of your record of changes exists only on this computer. That is fine for one person on one machine, where there is no separate system to send it to."
          : "The fingerprint of your record of changes exists only on this server, so anyone who can change the record can change the fingerprint with it."
      }</p>
      <p class="kpi-sub" style="margin-top:8px">To send it somewhere else, whoever runs the server sets
        <code>COSTGRID_ANCHOR_URL</code> and <code>COSTGRID_ANCHOR_KEY</code>, with a key from
        <code>costgrid audit keys</code>. A signed copy then goes to that address every hour, so a
        change here can be proved there.</p>
    </div>`;
  }
  const rows = a.recent
    .map(
      (r) => `<tr>
        <td class="num">#${r.anchorNo}</td>
        <td>${escapeHtml(r.at.slice(0, 19).replace("T", " "))}</td>
        <td class="num">${count(r.auditSeq)}</td>
        <td>${
          r.deliveredAt
            ? '<span class="tag on">delivered</span>'
            : `<span class="tag block">not delivered</span> <span class="kpi-sub">${r.attempts} tries</span>`
        }${r.lastError ? `<br /><span class="kpi-sub">${escapeHtml(r.lastError)}</span>` : ""}</td>
      </tr>`,
    )
    .join("");
  return `<div class="card">
    <p style="margin:0"><span class="tag ${a.undelivered === 0 ? "on" : "block"}">${
      a.undelivered === 0 ? "every anchor delivered" : `${a.undelivered} not delivered`
    }</span>
      &nbsp;to <code>${escapeHtml(a.receiverHost)}</code>, every ${a.intervalMinutes} minutes${
        a.lastDeliveredAt ? `, last ${relativeTime(a.lastDeliveredAt)}` : ""
      }.</p>
    <p class="kpi-sub" style="margin-top:8px">${
      a.undelivered === 0
        ? "They hold an independent copy of your record's fingerprint, so a change here can be proved there."
        : "Until they arrive there is a gap in the archive, and a gap is exactly what somebody covering their tracks would leave. Fix the destination."
    }</p>
    ${
      rows
        ? `<div class="scroll-x" style="margin-top:12px"><table>
             <thead><tr><th class="num">#</th><th>When</th><th class="num">Entries</th><th>State</th></tr></thead>
             <tbody>${rows}</tbody></table></div>`
        : '<p class="kpi-sub" style="margin-top:8px">No anchors yet. The first goes out within the hour.</p>'
    }
  </div>`;
}

function eraseSection(org, desktop) {
  return `<div class="card" style="border-color:var(--rust)">
    <p style="margin:0 0 8px">Deletes everything belonging to <strong>${escapeHtml(org.tenantName)}</strong>:
      every call, rule, key, report and the record of changes. ${
        desktop ? "Your account on this computer goes with it, and setup starts again." : ""
      } Nothing is recoverable afterwards, and no record of the deletion is kept inside CostGrid,
      because that record would itself be your data.</p>
    <p class="kpi-sub" style="margin-bottom:12px">This is the answer to a deletion request. The counts
      shown afterwards are the confirmation to close it with.</p>
    <form id="erase-form" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      ${field(`Type the organisation's name, ${org.tenantName}, to confirm`, "confirm", "text", 'autocomplete="off"')}
      <button type="submit" style="font-family:var(--mono);font-size:12px;letter-spacing:0.04em;padding:9px 16px;
        border:1px solid var(--rust);background:var(--rust);color:var(--bg);cursor:pointer;margin-bottom:14px">
        Delete everything</button>
    </form>
  </div>`;
}

export async function render() {
  const t = state.tenantId;
  const org = state.orgs.find((o) => o.tenantId === t);
  const desktop = state.setup?.singleAccount === true;
  const [anchors, audit] = await Promise.all([
    call("GET", `/console/${t}/audit/anchors`),
    call("GET", `/console/${t}/audit/verify`),
  ]);

  return `
    <h2>Your data</h2>
    <p class="section-note">Where it is, whether it has been touched, and how to take it away.</p>
    ${flashBanner()}

    <h2 style="margin-top:22px">Backup</h2>
    ${backupSection(desktop, t)}

    <h2 style="margin-top:26px">Proof the record has not been edited</h2>
    <p class="section-note">Every change is locked to the one before it, and the whole chain has one
      fingerprint. Sending that fingerprint somewhere CostGrid cannot reach is what turns a check
      into evidence.</p>
    <div class="card" style="margin-bottom:12px">
      <p style="margin:0"><span class="tag ${audit.intact ? "on" : "block"}">${
        audit.intact ? "nothing has been altered" : "check failed"
      }</span> &nbsp;${escapeHtml(audit.summary)}</p>
    </div>
    ${anchorsSection(anchors, desktop)}

    <h2 style="margin-top:26px">Delete everything</h2>
    ${eraseSection(org, desktop)}`;
}

export async function submit(form) {
  if (form.id !== "erase-form") return false;
  const t = state.tenantId;
  const org = state.orgs.find((o) => o.tenantId === t);
  const { confirm } = formValues(form);
  const result = await call("DELETE", `/console/${t}`, { confirm });

  const tables = Object.entries(result.tables)
    .sort()
    .map(([table, n]) => `${table} ${n}`)
    .join(", ");
  state.flash = {
    kind: "ok",
    text:
      `Deleted everything belonging to "${org.tenantName}": ${count(result.total)} rows` +
      (tables ? ` (${tables})` : "") +
      `. Completed ${new Date(result.erasedAt).toISOString().replace("T", " ").slice(0, 19)}. ` +
      "Keep this: no record of it remains inside CostGrid.",
  };
  // On a desktop install the account went too, so this lands on first-run setup.
  state.page = "settings";
  await loadSession();
  await loadSetup();
  return true;
}

export async function click() {
  return false;
}
