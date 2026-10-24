/**
 * Setup, as three steps an owner can finish without touching code: sign in,
 * connect the AI accounts, and say what each workflow is for.
 *
 * This file is the shell: it loads what each step needs, decides which step
 * is next, and lays them out. The steps render themselves (console-connect.js,
 * console-purpose.js) and handle their own forms. The developer route, traffic
 * through CostGrid, stays below them under "Advanced" (console-proxy.js).
 *
 * Every step reads its state from the server, so the page is right after a
 * reload and after doing the same thing elsewhere.
 */

import { call, flashBanner, state } from "./console-api.js";
import { connectDone, renderConnect } from "./console-connect.js";
import { proxyNeedsSetup, renderSteps } from "./console-proxy.js";
import { purposeDone, renderPurposes } from "./console-purpose.js";
import { escapeHtml, pageHead } from "./ui.js";

/** Whether "Advanced" was left open, so a redraw does not fold it away. */
let advancedOpen = false;

/**
 * True until there is usage to show: nothing imported, no sources, and the
 * proxy route not set up either. A server too old for /connect falls back to
 * the proxy rule alone.
 */
export async function needsSetup(tenantId) {
  const connect = await call("GET", `/console/${tenantId}/connect`).catch(() => null);
  if (connectDone(connect)) return false;
  return proxyNeedsSetup(tenantId);
}

const settle = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );

const TAGS = {
  done: '<span class="tag on">Done</span>',
  next: '<span class="tag warn">Next</span>',
  later: '<span class="tag">Later</span>',
};

function step(n, title, status, body) {
  return `<li class="stepper-step is-${status}">
    <span class="stepper-marker" aria-hidden="true">${n}</span>
    <section class="card stepper-card" aria-labelledby="setup-step-${n}">
      <div class="stepper-head">
        <h2 id="setup-step-${n}">${escapeHtml(title)}</h2>${TAGS[status]}
      </div>
      ${body}
    </section>
  </li>`;
}

const failed = (what, error) =>
  `<div class="banner bad"><strong>${escapeHtml(`${what} could not be loaded: ${error.message}`)}</strong></div>`;

export async function render() {
  const t = state.tenantId;
  const [connect, sourceList, presetList, proxy] = await Promise.all([
    settle(call("GET", `/console/${t}/connect`)),
    settle(call("GET", `/console/${t}/sources?days=90`)),
    settle(call("GET", "/console/presets")),
    settle(renderSteps()),
  ]);

  const sources = sourceList.value?.sources ?? [];
  const presets = presetList.value?.presets ?? [];
  const connected = connectDone(connect.value) || sources.length > 0;
  const named = purposeDone(sources);
  const status2 = connected ? "done" : "next";
  const status3 = named ? "done" : connected ? "next" : "later";

  // Only a desktop install keeps the account on this computer; a hosted one does not.
  const signedIn = `<p>Signed in as <strong>${escapeHtml(state.user.email)}</strong>.${
    state.setup?.singleAccount === true ? " This account stays on this computer." : ""
  }</p>`;
  const connectBody = connect.value ? renderConnect(connect.value) : failed("Your connections", connect.error);
  const purposeBody = sourceList.error
    ? failed("Your keys and projects", sourceList.error)
    : renderPurposes(sources, presets, connected);

  return `
    ${pageHead("Set up CostGrid", "Three steps to see what each successful AI job costs you.")}
    ${flashBanner()}
    <ol class="stepper">
      ${step(1, "Sign in", "done", signedIn)}
      ${step(2, "Connect your AI accounts", status2, connectBody)}
      ${step(3, "Say what each workflow is for", status3, purposeBody)}
    </ol>

    <details class="advanced"${advancedOpen ? " open" : ""}>
      <summary>Advanced: send traffic through CostGrid</summary>
      <p class="section-note">For developers. Point your software at CostGrid instead of the
        provider, and every call is measured as it happens and can be held to a limit. It takes a
        change in your code, so the three steps above are the place to start.</p>
      ${proxy.value ?? failed("These steps", proxy.error)}
    </details>`;
}

// <details> fires "toggle" without bubbling, so listen while it passes down.
document.addEventListener(
  "toggle",
  (event) => {
    if (event.target instanceof Element && event.target.matches("details.advanced")) {
      advancedOpen = event.target.open;
    }
  },
  true,
);
