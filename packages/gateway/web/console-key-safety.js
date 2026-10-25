/**
 * "Key safety" on the Setup screen: warnings about risky key setups, each
 * with what could go wrong and the one thing that fixes it.
 *
 * Read-only. CostGrid changes nothing at the provider from here; every fix is
 * something the owner does in the provider's console or in the steps above.
 * Every string from the server goes through escapeHtml.
 */

import { escapeHtml } from "./ui.js";

const PROVIDER = { anthropic: "Claude", openai: "OpenAI" };
const CONSOLE = { anthropic: "the Claude Console", openai: "the OpenAI dashboard" };
const TONE = { high: "block", medium: "warn", low: "" };
const LEVEL = { high: "Fix now", medium: "Worth fixing", low: "Good practice" };

const providerName = (p) => PROVIDER[p] ?? p;

function subjectName(w) {
  const s = w.subject;
  if (!s) return "";
  const what = s.kind === "workspace" ? "workspace" : s.kind === "project" ? "project" : "key";
  return s.label ? `The ${what} “${escapeHtml(s.label)}”` : `The ${what} <code>${escapeHtml(s.id)}</code>`;
}

/** [what is wrong, how to fix it], both markup. */
function words(w, recentDays) {
  const p = escapeHtml(providerName(w.provider));
  const where = escapeHtml(CONSOLE[w.provider] ?? "the provider's console");
  const days = escapeHtml(String(w.days ?? ""));
  const name = subjectName(w);
  switch (w.code) {
    case "admin-key-expired":
      return [`Your ${p} admin key has expired, so no new usage is coming in.`, `Make a new admin key in ${where} and connect it in step 2.`];
    case "admin-key-failing":
      return [
        `The last sync with your ${p} admin key failed. It may have been deleted or lost its permissions.`,
        "Step 2 shows the error. Connect a new key if this one was deleted.",
      ];
    case "admin-key-expiring":
      return [`Your ${p} admin key stops working in ${days} ${w.days === 1 ? "day" : "days"}.`, `Make a new one in ${where} before then and connect it in step 2.`];
    case "shared-key":
      return [
        `${name} is used by more than one agent, so its cost can't be split and it can't be stopped for one agent alone.`,
        "Give each agent its own key. The guide in step 3 shows how.",
      ];
    case "unassigned-spend":
      return [
        `${name} spent $${escapeHtml(w.recentCostUsd)} in the last ${escapeHtml(String(recentDays))} days and isn't matched to an agent.`,
        "Match it to the agent that uses it in step 3.",
      ];
    case "unused-active-key":
      return [
        w.neverUsed
          ? `${name} still works but has never been used since it was made ${days} days ago.`
          : w.atLeast
            ? `${name} still works but no use of it has been seen in the last ${days} days.`
            : `${name} still works but hasn't been used for ${days} days.`,
        `If nothing needs it, delete it in ${where}. A working key nobody uses is a risk if it leaks, with nothing gained.`,
      ];
    case "account-level-usage":
      return [
        `${p} reported $${escapeHtml(w.recentCostUsd)} of usage for the whole account without saying which key it was.`,
        "Connect an admin key in step 2, which reports usage per key.",
      ];
    case "default-workspace-key":
      return [
        `${name} is in Claude's Default workspace, which can't have a spending limit of its own.`,
        "Make a new key for the agent in a workspace of its own, set that workspace a limit, then delete this key.",
      ];
    case "personal-key":
      return [
        `${name} belongs to a person rather than a service account.`,
        "For software, a service account key in the project isn't tied to anyone's login, so it is easier to hand over and account for.",
      ];
    case "old-key":
      return [`${name} is ${days} days old.`, `Replace keys now and then in ${where}, so an old copy that leaked stops working.`];
    default:
      return [escapeHtml(w.code), ""];
  }
}

/** The section's markup. `payload` is GET /console/:t/key-safety; null when it could not be loaded. */
export function keySafetySection(payload) {
  if (!payload) return "";
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const note = payload.keysChecked
    ? ""
    : `<p class="kpi-sub">Connect an admin key in step 2 and CostGrid can also check each key's age, last use and workspace.</p>`;
  const body = warnings.length
    ? `<ul class="key-warnings">${warnings
        .map((w) => {
          const [what, fix] = words(w, payload.recentDays ?? 30);
          const tone = TONE[w.severity] ?? "";
          return `<li class="key-warning"><span class="tag ${tone}">${escapeHtml(LEVEL[w.severity] ?? w.severity)}</span>
            <div><p>${what}</p>${fix ? `<p class="kpi-sub">${fix}</p>` : ""}</div></li>`;
        })
        .join("")}</ul>`
    : `<p><span class="tag on">Nothing to fix</span> No risky key setups found.</p>`;
  return `<section class="card key-safety" aria-labelledby="key-safety-head">
      <h2 id="key-safety-head">Key safety</h2>
      <p class="section-note">Checked from what your providers list about each key, never the keys themselves.
        Nothing is changed at your providers from here.</p>
      ${body}${note}
    </section>`;
}
