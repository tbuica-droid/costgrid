/**
 * What every console screen shares: who is signed in, how to talk to the
 * server, and the one-line notice shown after an action.
 *
 * Its own file so the screens can import it without importing each other.
 */

import { escapeHtml } from "./ui.js";

export const state = {
  user: null,
  orgs: [],
  tenantId: null,
  /** Signed out: which form, login or signup. */
  view: "login",
  /** Signed in: which screen. */
  page: "settings",
  flash: null,
  setup: null,
};

export async function call(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `request failed (${response.status})`);
  return payload;
}

export function flashBanner() {
  if (!state.flash) return "";
  const { kind, text } = state.flash;
  const colour = kind === "error" ? "var(--rust)" : "var(--green)";
  return `<div class="banner" style="border-color:${colour}"><strong style="color:${colour}">
    ${escapeHtml(text)}</strong></div>`;
}

export function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export async function loadSession() {
  try {
    const me = await call("GET", "/console/me");
    state.user = me.user;
    state.orgs = me.organisations;
    if (!state.orgs.some((o) => o.tenantId === state.tenantId)) {
      state.tenantId = me.organisations[0]?.tenantId ?? null;
    }
  } catch {
    state.user = null;
    state.orgs = [];
    state.tenantId = null;
  }
}

/** On a desktop install, which of the two signed-out forms is the right one right now. */
export async function loadSetup() {
  state.setup = await call("GET", "/console/setup").catch(() => null);
  if (state.setup?.singleAccount) state.view = state.setup.needsAccount ? "signup" : "login";
}
