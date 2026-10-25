/**
 * The "Match repeat jobs" card on the Settings screen: the switch for the
 * one-way code CostGrid makes from each job's first message, and a plain
 * account of what that code is.
 *
 * Only an owner can flip it. Turning it off deletes the codes already saved,
 * so that direction asks first.
 */

import { call, state } from "./console-api.js";
import { isOwner } from "./console-outcomes.js";
import { button } from "./ui.js";

const SWITCH_COPY = `Match repeat jobs. Turn this off and CostGrid still spots hand-offs and errors, but can't tell when
  a job finished. Codes already saved are deleted.`;

const EXPLAIN = `To notice when the same job is asked again, CostGrid turns the first message of each job into a
  one-way code on this computer. The words are never saved, the code can't be turned back into them, it never leaves
  this computer, and it's deleted with your other call records. A job your software labels with the
  <code>x-costgrid-task</code> header is matched by that label instead.`;

/** The card's markup. `settings` is GET /console/:t/outcome-settings, or null when that failed. */
export function outcomeSettingsCard(settings) {
  if (!settings) {
    return `<div class="banner bad" role="status"><strong>This setting couldn't be loaded.</strong> Try again in a
      moment.</div>`;
  }
  if (!settings.available) {
    return `<div class="card"><p class="kpi-sub" style="margin:0">This install has no key to make these codes, so jobs
      can only be matched by the <code>x-costgrid-task</code> header your software sends. CostGrid still spots
      hand-offs and errors.</p></div>`;
  }
  const on = settings.enabled === true;
  const control = isOwner()
    ? button(
        on ? "Turn off" : "Turn on",
        `type="button" data-action="outcome-settings-toggle" data-enabled="${on ? "false" : "true"}"`,
        on ? "danger btn-sm" : "sm",
      )
    : '<span class="kpi-sub">Only an owner of this organisation can change this.</span>';
  return `<div class="card">
      <div class="form-row">
        <span class="tag ${on ? "on" : ""}">${on ? "On" : "Off"}</span>
        ${control}
      </div>
      <p style="margin:12px 0 0">${SWITCH_COPY}</p>
      <p class="kpi-sub" style="margin:10px 0 0">${EXPLAIN}</p>
    </div>`;
}

export async function submit() {
  return false;
}

export async function click(target) {
  if (target.dataset.action !== "outcome-settings-toggle") return false;
  const enabled = target.dataset.enabled === "true";
  if (!enabled && !confirm("Turn off matching repeat jobs? The codes already saved are deleted.")) return true;
  await call("PUT", `/console/${state.tenantId}/outcome-settings`, { enabled });
  state.flash = {
    kind: "ok",
    text: enabled ? "Matching repeat jobs is on." : "Matching repeat jobs is off. The saved codes were deleted.",
  };
  return true;
}
