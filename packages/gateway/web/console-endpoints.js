/**
 * "Open models and other providers" on Settings (v3, phase 3).
 *
 * Connect a service that accepts OpenAI-format requests, list the models it
 * serves with their prices and where those came from, and say per agent where
 * its calls may be sent beyond its own provider. Nothing is sent anywhere new
 * until an agent is opted in here and a rule on Limits routes it.
 */

import { call, state } from "./console-api.js";
import { isOwner } from "./console-outcomes.js";
import { button, escapeHtml, field } from "./ui.js";

const DESTINATION_WORDS = { openai: "OpenAI", anthropic: "Claude (Anthropic)" };

function destinationLabel(d, endpoints) {
  if (DESTINATION_WORDS[d]) return DESTINATION_WORDS[d];
  const e = endpoints.find((x) => `open:${x.id}` === d);
  return e ? e.name : d;
}

function modelRows(e) {
  if (e.models.length === 0) return '<p class="kpi-sub">No models yet.</p>';
  return `<div class="scroll-x"><table>
    <thead><tr><th>Model, as rules name it</th><th class="num">Input / M</th><th class="num">Output / M</th><th>Prices from</th><th></th></tr></thead>
    <tbody>${e.models
      .map(
        (m) => `<tr><td><code>${escapeHtml(m.id)}</code></td>
          <td class="num">${m.inputPerMUsd === null ? '<span class="tag warn">not priced</span>' : `$${escapeHtml(m.inputPerMUsd)}`}</td>
          <td class="num">${m.outputPerMUsd === null ? "" : `$${escapeHtml(m.outputPerMUsd)}`}</td>
          <td style="white-space:normal">${m.priceSource ? `${escapeHtml(m.priceSource)}, ${escapeHtml(m.pricedOn ?? "")}` : "—"}</td>
          <td class="num">${isOwner() ? `<button type="button" class="btn btn-sm btn-danger" data-action="endpoint-model-remove" data-endpoint="${escapeHtml(e.id)}" data-model="${escapeHtml(m.model)}">Remove</button>` : ""}</td></tr>`,
      )
      .join("")}</tbody></table></div>
    ${e.models.some((m) => m.inputPerMUsd === null) ? '<p class="kpi-sub">A model with no price is never routed to: its calls could not be priced.</p>' : ""}`;
}

function endpointCard(e) {
  const owner = isOwner();
  return `<div class="card" style="margin-bottom:12px">
    <h3 style="margin-top:0">${escapeHtml(e.name)} <span class="kpi-sub"><code>open:${escapeHtml(e.id)}</code></span></h3>
    <p class="kpi-sub">${escapeHtml(e.baseUrl)} · ${e.keyHint ? `key <code>${escapeHtml(e.keyHint)}</code>` : "no key"}</p>
    ${modelRows(e)}
    ${
      owner
        ? `<form class="endpoint-model-form form-row" data-endpoint="${escapeHtml(e.id)}" style="flex-wrap:wrap;margin-top:10px">
            <input name="model" placeholder="Model name at this service" required style="min-width:240px" />
            <input name="inputPerMUsd" placeholder="Input $/M" style="width:110px" />
            <input name="outputPerMUsd" placeholder="Output $/M" style="width:110px" />
            <input name="cachedInputPerMUsd" placeholder="Cached $/M (optional)" style="width:160px" />
            <input name="priceSource" placeholder="Where the prices are published" style="min-width:220px" />
            <input name="pricedOn" type="date" aria-label="Date you read the prices" />
            ${button("Add model", 'type="submit"', "secondary")}
          </form>
          <p style="margin-top:10px">${button("Remove this service", `type="button" data-action="endpoint-remove" data-endpoint="${escapeHtml(e.id)}"`, "danger")}</p>`
        : ""
    }
  </div>`;
}

function optInTable(data) {
  if (data.agents.length === 0) return "";
  const choices = ["openai", "anthropic", ...data.endpoints.map((e) => `open:${e.id}`)];
  const owner = isOwner();
  return `<div class="card">
    <p class="kpi-sub" style="margin-top:0"><strong>Where each agent's requests may go.</strong> Ticking a box allows a
      rule on Limits to send that agent's requests, including what your customers wrote, to that service, under its
      own terms. Untick it and nothing more goes there. CostGrid itself still keeps no prompt and no answer.</p>
    <div class="scroll-x"><table>
      <thead><tr><th>Agent</th>${choices.map((c) => `<th>${escapeHtml(destinationLabel(c, data.endpoints))}</th>`).join("")}<th></th></tr></thead>
      <tbody>${data.agents
        .map(
          (a) => `<tr><td>${escapeHtml(a.name ?? a.id)}</td>
            ${choices
              .map(
                (c) => `<td><input type="checkbox" form="optin-${escapeHtml(a.id)}" name="d" value="${escapeHtml(c)}"
                  ${a.destinations.includes(c) ? "checked" : ""} ${owner ? "" : "disabled"}
                  aria-label="${escapeHtml(`${a.name ?? a.id} to ${destinationLabel(c, data.endpoints)}`)}" /></td>`,
              )
              .join("")}
            <td>${owner ? `<form id="optin-${escapeHtml(a.id)}" class="optin-form" data-agent="${escapeHtml(a.id)}">${button("Save", 'type="submit"', "secondary")}</form>` : ""}</td></tr>`,
        )
        .join("")}</tbody></table></div>
  </div>`;
}

/** The Settings section. `data` is GET /console/:t/endpoints, or null when it failed. */
export function endpointsSection(data) {
  if (!data) return '<div class="banner bad" role="status"><strong>Open models couldn\'t be loaded.</strong></div>';
  const owner = isOwner();
  return `${data.endpoints.map(endpointCard).join("")}
    ${
      owner
        ? `<form id="endpoint-form" class="card" style="margin-bottom:12px">
            <p class="kpi-sub" style="margin-top:0">Connect any service that accepts OpenAI-format requests: a hosted
              open-model service, or a model running on this computer. Its address ends in the API version, like
              <code>https://api.together.xyz/v1</code> or <code>http://127.0.0.1:11434/v1</code>.</p>
            ${field("Short name, used in model ids", "id", "text", 'placeholder="together" pattern="[a-z0-9][a-z0-9-]*" required')}
            ${field("Name", "name", "text", 'placeholder="Together AI" required')}
            ${field("Address", "baseUrl", "url", 'placeholder="https://api.together.xyz/v1" required')}
            ${field("Key (leave empty for a server that takes none)", "apiKey", "password", 'autocomplete="off"')}
            ${button("Connect", 'type="submit"')}
          </form>`
        : ""
    }
    ${optInTable(data)}`;
}

export async function submit(form) {
  const t = state.tenantId;
  const v = Object.fromEntries(new FormData(form).entries());
  if (form.id === "endpoint-form") {
    await call("PUT", `/console/${t}/endpoints/${encodeURIComponent(String(v.id).trim())}`, {
      name: v.name,
      baseUrl: v.baseUrl,
      ...(v.apiKey ? { apiKey: v.apiKey } : {}),
    });
    state.flash = { kind: "ok", text: "Connected. Add the models it serves, with their prices." };
    return true;
  }
  if (form.classList.contains("endpoint-model-form")) {
    await call("PUT", `/console/${t}/endpoints/${encodeURIComponent(form.dataset.endpoint)}/models`, v);
    state.flash = { kind: "ok", text: "Model saved." };
    return true;
  }
  if (form.classList.contains("optin-form")) {
    const ticked = [...document.querySelectorAll(`input[form="${form.id}"]:checked`)].map((i) => i.value);
    await call("PUT", `/console/${t}/agents/${encodeURIComponent(form.dataset.agent)}/destinations`, { destinations: ticked });
    state.flash = { kind: "ok", text: "Saved. Rules on Limits may now send this agent's requests to the ticked services." };
    return true;
  }
  return false;
}

export async function click(target) {
  const t = state.tenantId;
  if (target.dataset.action === "endpoint-remove") {
    await call("DELETE", `/console/${t}/endpoints/${encodeURIComponent(target.dataset.endpoint)}`);
    state.flash = { kind: "ok", text: "Removed. Agents opted in to it no longer are." };
    return true;
  }
  if (target.dataset.action === "endpoint-model-remove") {
    await call(
      "DELETE",
      `/console/${t}/endpoints/${encodeURIComponent(target.dataset.endpoint)}/models?model=${encodeURIComponent(target.dataset.model)}`,
    );
    state.flash = { kind: "ok", text: "Model removed." };
    return true;
  }
  return false;
}
