/**
 * CostGrid console — signup, login, and the screens behind them.
 *
 * Talks only to /console/*, which authenticates with a session cookie. The
 * dashboard at / is separate and uses an API key; keeping the two apart means
 * a browser session can never be used to spend tokens.
 *
 * This file is the shell: the signed-out forms, the navigation, and the
 * dispatch of forms and buttons to whichever screen owns them. Each screen
 * renders itself and handles its own forms; the settings forms are handled
 * here because they predate the split.
 */

import {
  call,
  flashBanner,
  formValues,
  loadSession,
  loadSetup,
  state,
} from "./console-api.js";
import * as advice from "./console-advice.js";
import * as connect from "./console-connect.js";
import * as data from "./console-data.js";
import * as drift from "./console-drift.js";
import * as limits from "./console-limits.js";
import * as proxy from "./console-proxy.js";
import * as agents from "./console-agents.js";
import * as results from "./console-results.js";
import * as outcomes from "./console-outcomes.js";
import * as verdict from "./console-verdict.js";
import * as control from "./console-control.js";
import * as outcomeSettings from "./console-settings-outcomes.js";
import { renderSettings } from "./console-settings.js";
import * as wizard from "./console-wizard.js";
import { button, escapeHtml, field, icon, pageHead, setAppearance } from "./ui.js";

const PAGES = [
  ["setup", "Setup", wizard.render],
  ["limits", "Limits", limits.render],
  ["results", "Results", results.render],
  ["settings", "Settings", renderSettings],
  ["advice", "Advice", advice.render],
  ["drift", "What changed", drift.render],
  ["data", "Data", data.render],
];
const SCREENS = [connect, agents, proxy, limits, results, outcomes, verdict, control, outcomeSettings, advice, drift, data];

// ------------------------------------------------------------- signed out

function renderAuth() {
  const signingUp = state.view === "signup";
  // A desktop install has exactly one account, so there is only ever one
  // right form: create it on the first visit, sign in on every visit after.
  const desktop = state.setup?.singleAccount === true;
  const heading = signingUp ? (desktop ? "Set up CostGrid on this computer" : "Create an account") : "Sign in";
  const note = desktop
    ? `This account lives only on this computer and is not sent anywhere. It locks the
       console where your provider keys are kept, encrypted${
         state.setup.keychain ? " with a key held in your keychain" : " before they touch disk"
       }.`
    : `CostGrid meters and governs your LLM spend. You bring your own provider keys; they
       are encrypted before they touch disk and are never shown again.`;

  return `
    <div style="max-width:480px">
      ${pageHead(heading, note)}
      ${flashBanner()}
      <form id="auth-form" class="card">
        ${signingUp ? field("Your name", "name") : ""}
        ${signingUp ? field("Organisation", "organisation") : ""}
        ${field("Email", "email", "email")}
        <!-- Left empty by people; a bot that fills every field is refused by the server. -->
        <input name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px" />
        ${field("Password", "password", "password", signingUp ? 'minlength="12"' : "")}
        ${signingUp ? '<p class="kpi-sub" style="margin:-6px 0 14px">At least 12 characters.</p>' : ""}
        ${button(signingUp ? "Create account" : "Sign in", 'type="submit"')}
      </form>
      ${
        desktop
          ? ""
          : `<p class="section-note" style="margin-top:18px">${
              signingUp
                ? 'Already have an account? <a href="#" data-view="login">Sign in</a>.'
                : 'No account? <a href="#" data-view="signup">Create one</a>.'
            }</p>`
      }
    </div>`;
}

/** Signed in, but a member of nothing: what is left after an organisation is erased. */
function renderNoOrganisation() {
  return `
    <div style="max-width:560px">
      ${pageHead(
        "Nothing here",
        `You are signed in as ${escapeHtml(state.user.email)} but are not a member of any organisation.`,
        '<a href="#" id="logout" class="btn">Sign out</a>',
      )}
      ${flashBanner()}
    </div>`;
}

// ------------------------------------------------------------------- shell

/** The sidebar: whose workspace this is, then one item per screen. */
function renderNav() {
  const nav = document.getElementById("nav");
  const workspace = document.getElementById("workspace");
  if (!state.user || !state.tenantId) {
    nav.innerHTML = "";
    workspace.hidden = true;
    workspace.innerHTML = "";
    return;
  }
  const current = state.orgs.find((o) => o.tenantId === state.tenantId);
  const orgs =
    state.orgs.length > 1
      ? `<div class="workspace-orgs" role="group" aria-label="Switch organisation">${state.orgs
          .map(
            (o) => `<button data-tenant="${escapeHtml(o.tenantId)}"
                 aria-current="${o.tenantId === state.tenantId}">${escapeHtml(o.tenantName)}</button>`,
          )
          .join("")}</div>`
      : "";
  workspace.innerHTML = `<span class="workspace-name">${escapeHtml(current?.tenantName ?? "Organisation")}</span>
    <span class="workspace-note">${escapeHtml(state.user.email)}</span>${orgs}`;
  workspace.hidden = false;
  nav.innerHTML = PAGES.map(
    ([id, label]) =>
      `<button class="nav-item" data-page="${id}" aria-current="${id === state.page}">${icon(id)}${escapeHtml(label)}</button>`,
  ).join("");
}

async function render() {
  const main = document.getElementById("main");
  try {
    if (!state.user) main.innerHTML = renderAuth();
    else if (!state.tenantId) main.innerHTML = renderNoOrganisation();
    else main.innerHTML = await (PAGES.find(([id]) => id === state.page) ?? PAGES.find(([id]) => id === "settings"))[2]();
    document.getElementById("footer-note").textContent = state.user
      ? `${state.orgs.length} organisation${state.orgs.length === 1 ? "" : "s"}`
      : "";
  } catch (error) {
    main.innerHTML = `<div class="banner bad"><strong>${escapeHtml(error.message)}</strong></div>`;
  }
  renderNav();
  state.flash = null;
}

/** Which screen to open: the address bar if it names one, else setup until it is done. */
async function choosePage() {
  const requested = location.hash.slice(1);
  if (PAGES.some(([id]) => id === requested)) {
    state.page = requested;
    return;
  }
  if (!state.tenantId) return;
  state.page = (await wizard.needsSetup(state.tenantId).catch(() => false)) ? "setup" : "settings";
}

document.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();

  try {
    if (form.id === "auth-form") {
      const values = formValues(form);
      try {
        await call("POST", state.view === "signup" ? "/console/signup" : "/console/login", values);
      } finally {
        // A stale first-run page gets refused once the account exists. Refreshing
        // here flips it to sign-in instead of leaving a form that cannot succeed.
        await loadSetup();
      }
      await loadSession();
      await choosePage();
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
    } else if (form.id === "sso-form") {
      const values = formValues(form);
      // The technical endpoints are looked up from the issuer, so the person
      // filling this in needs two fields from their IT team rather than five.
      const endpoints = await call("POST", `/console/${state.tenantId}/sso/discover`, {
        issuer: values.issuer,
      });
      await call("PUT", `/console/${state.tenantId}/sso`, {
        issuer: values.issuer,
        clientId: values.clientId,
        clientSecret: values.clientSecret,
        authorizeUrl: endpoints.authorizeUrl,
        tokenUrl: endpoints.tokenUrl,
        jwksUrl: endpoints.jwksUrl,
        emailDomains: String(values.emailDomains || "")
          .split(/[,\s]+/)
          .filter(Boolean),
        enforced: form.elements.enforced.checked,
      });
      state.flash = { kind: "ok", text: "Company sign-in saved. Try it from a private window before telling anyone." };
    } else if (form.id === "retention-form") {
      const { callDays, eventDays } = formValues(form);
      await call("PUT", `/console/${state.tenantId}/retention`, {
        callDays: Number(callDays),
        eventDays: Number(eventDays),
      });
      state.flash = {
        kind: "ok",
        text: "Saved. Nothing has been deleted yet; the limit is applied once a day.",
      };
    } else if (form.classList.contains("cred-form")) {
      const { apiKey } = formValues(form);
      if (!apiKey) return;
      await call("PUT", `/console/${state.tenantId}/credentials/${form.dataset.provider}`, { apiKey });
      state.flash = { kind: "ok", text: `${form.dataset.provider} credential saved.` };
    } else {
      let handled = false;
      for (const screen of SCREENS) {
        if (await screen.submit(form)) {
          handled = true;
          break;
        }
      }
      if (!handled) return;
    }
  } catch (error) {
    state.flash = { kind: "error", text: error.message };
  }
  await render();
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest(
    "[data-view], [data-tenant], [data-page], [data-action], [data-remove], [data-revoke], [data-appearance], #logout",
  );
  if (!target) return;
  event.preventDefault();

  try {
    if (target.dataset.appearance) {
      setAppearance(target.dataset.appearance);
    } else if (target.dataset.view) {
      state.view = target.dataset.view;
    } else if (target.dataset.tenant) {
      state.tenantId = target.dataset.tenant;
    } else if (target.dataset.page) {
      state.page = target.dataset.page;
      history.replaceState(null, "", `#${state.page}`);
    } else if (target.dataset.action) {
      for (const screen of SCREENS) if (await screen.click(target)) break;
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

// A screen that notices something on its own (the first call arriving) asks
// for a redraw this way rather than reaching into the page.
document.addEventListener("costgrid:render", () => void render());

await loadSession();
await loadSetup();
await choosePage();
await render();
