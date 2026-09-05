/**
 * CostGrid dashboard.
 *
 * Every number rendered here comes from the API, which reads metered calls.
 * There is no seeded data and no fallback sample set: when there is nothing to
 * show, the view says so. A dashboard that invents plausible numbers when the
 * database is empty is how a demo gets mistaken for a deployment.
 *
 * Money arrives as decimal strings and is formatted, never arithmetic'd — the
 * exact arithmetic already happened server-side in integer nanodollars.
 */

const state = { view: "overview", days: 30 };

// ------------------------------------------------------------------ helpers

async function api(path) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`/api/${path}${separator}days=${state.days}`);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error ?? `request failed (${response.status})`);
  }
  return response.json();
}

/** Format a decimal-string USD amount. Sub-cent values keep their precision. */
function money(decimalString) {
  const value = Number(decimalString);
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toPrecision(2)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  if (value < 1_000_000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${(value / 1_000_000).toFixed(2)}M`;
}

const pct = (fraction, digits = 1) => `${(fraction * 100).toFixed(digits)}%`;
const count = (n) => n.toLocaleString("en-US");

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function card(label, value, sub, accent = "") {
  return `<div class="card">
    <div class="rail">${escapeHtml(label)}</div>
    <div class="kpi-value ${accent}">${value}</div>
    <div class="kpi-sub">${sub}</div>
  </div>`;
}

/** Warn when part of the spend is not priced, rather than quietly under-reporting. */
function unpricedBanner(unpricedCalls) {
  if (!unpricedCalls) return "";
  return `<div class="banner"><strong>${count(unpricedCalls)} unpriced call${
    unpricedCalls === 1 ? "" : "s"
  }.</strong>
    A model in this window is missing from the price catalog, so its cost reads as zero
    and every total below is understated. Check the Pricing tab for what is catalogued.</div>`;
}

function emptyState() {
  return `<div class="empty">
    No calls recorded in this window.<br /><br />
    Point a client at this gateway and make a request:<br />
    <code>curl ${location.origin}/v1/messages -d '{"model":"claude-opus-5",…}'</code>
  </div>`;
}

// ------------------------------------------------------------------- charts

/** Daily spend bars. Inline SVG so the dashboard needs no charting library. */
function barChart(buckets) {
  if (buckets.length === 0) return "";

  const width = 900;
  const height = 200;
  const pad = { top: 12, bottom: 26, left: 0, right: 0 };
  const max = Math.max(...buckets.map((b) => Number(b.costUsd)), 1e-9);
  const slot = (width - pad.left - pad.right) / buckets.length;
  const barWidth = Math.max(1, slot * 0.72);
  const plotHeight = height - pad.top - pad.bottom;

  const bars = buckets
    .map((bucket, index) => {
      const value = Number(bucket.costUsd);
      const barHeight = Math.max(value > 0 ? 1 : 0, (value / max) * plotHeight);
      const x = pad.left + index * slot + (slot - barWidth) / 2;
      const y = pad.top + plotHeight - barHeight;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}"
        height="${barHeight.toFixed(1)}" fill="var(--ink)">
        <title>${escapeHtml(bucket.day)} — ${money(bucket.costUsd)}, ${bucket.calls} calls</title>
      </rect>`;
    })
    .join("");

  const firstDay = buckets[0].day;
  const lastDay = buckets[buckets.length - 1].day;

  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
      aria-label="Daily spend">
    <line x1="0" y1="${pad.top + plotHeight}" x2="${width}" y2="${pad.top + plotHeight}"
      stroke="var(--rule)" />
    ${bars}
    <text x="0" y="${height - 6}" font-family="var(--mono)" font-size="11"
      fill="rgba(15,20,17,0.5)">${escapeHtml(firstDay)}</text>
    <text x="${width}" y="${height - 6}" text-anchor="end" font-family="var(--mono)"
      font-size="11" fill="rgba(15,20,17,0.5)">${escapeHtml(lastDay)} · peak ${money(String(max))}</text>
  </svg>`;
}

/** The blended-cost curve, with the observed and optimal shares marked. */
function curveChart(routing) {
  const width = 600;
  const height = 260;
  const pad = { top: 14, bottom: 30 };
  const plotHeight = height - pad.top - pad.bottom;

  const costs = routing.curve.map((p) => p.cost);
  const min = Math.min(...costs);
  const max = Math.max(...costs);
  const span = max - min || 1;

  const y = (cost) => pad.top + plotHeight - ((cost - min) / span) * plotHeight;
  const x = (share) => share * width;

  const path = routing.curve
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.share).toFixed(1)},${y(p.cost).toFixed(1)}`)
    .join(" ");

  const marker = (share, cost, color, label, anchor) => `
    <line x1="${x(share).toFixed(1)}" y1="${pad.top}" x2="${x(share).toFixed(1)}"
      y2="${pad.top + plotHeight}" stroke="${color}" stroke-width="1" stroke-dasharray="3 4" />
    <circle cx="${x(share).toFixed(1)}" cy="${y(cost).toFixed(1)}" r="4.5" fill="${color}" />
    <text x="${(x(share) + (anchor === "end" ? -6 : 6)).toFixed(1)}" y="${pad.top + 11}"
      text-anchor="${anchor}" font-family="var(--mono)" font-size="11" fill="${color}">${label}</text>`;

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Blended cost curve">
    <line x1="0" y1="${pad.top + plotHeight}" x2="${width}" y2="${pad.top + plotHeight}"
      stroke="var(--rule)" />
    <path d="${path}" fill="none" stroke="var(--ink)" stroke-width="2" />
    ${marker(routing.optimalShare, routing.optimalBlendedCost, "var(--gold)",
      `optimum ${pct(routing.optimalShare, 0)}`, "end")}
    ${marker(routing.observedShare, routing.observedBlendedCost, "var(--rust)",
      `you ${pct(routing.observedShare, 0)}`, "start")}
    <text x="0" y="${height - 8}" font-family="var(--mono)" font-size="11"
      fill="rgba(15,20,17,0.5)">$${min.toFixed(2)}/Mtok at optimum</text>
    <text x="${width}" y="${height - 8}" text-anchor="end" font-family="var(--mono)"
      font-size="11" fill="rgba(15,20,17,0.5)">substitution share →</text>
  </svg>`;
}

function breakdownTable(rows, label) {
  if (rows.length === 0) return `<p class="kpi-sub">Nothing recorded.</p>`;
  const max = Math.max(...rows.map((r) => Number(r.costUsd)), 1e-12);

  const body = rows
    .map((row) => {
      const share = (Number(row.costUsd) / max) * 100;
      return `<tr>
        <td>${escapeHtml(row.key)}</td>
        <td style="width:38%">
          <div style="height:7px;background:var(--ink);width:${share.toFixed(1)}%"></div>
        </td>
        <td class="num">${money(row.costUsd)}</td>
        <td class="num">${count(row.calls)}</td>
      </tr>`;
    })
    .join("");

  return `<div class="scroll-x"><table>
    <thead><tr>
      <th>${escapeHtml(label)}</th><th></th><th class="num">Cost</th><th class="num">Calls</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

// -------------------------------------------------------------------- views

async function renderOverview() {
  const [overview, daily, byModel, byAgent, byDept] = await Promise.all([
    api("overview"),
    api("spend/daily"),
    api("spend/by/model"),
    api("spend/by/agent"),
    api("spend/by/department"),
  ]);

  if (overview.calls === 0) return emptyState();

  const kpis = [
    card("Spend", money(overview.totalCostUsd),
      `${money(String(overview.runRate30dUsd))} projected per 30 days`),
    card("Calls", count(overview.calls),
      `${count(overview.blockedCalls)} blocked · ${count(overview.erroredCalls)} errored`),
    card("Cache hit ratio", pct(overview.cacheHitRatio),
      `${count(overview.cacheReadTokens)} tokens served from cache`,
      overview.cacheHitRatio > 0.3 ? "accent-green" : ""),
    card("Substitution share", pct(overview.substitutionShare),
      `modelled optimum ${pct(overview.routing.optimalShare, 0)}`, "accent-gold"),
  ].join("");

  return `
    ${unpricedBanner(overview.unpricedCalls)}
    <h2>Overview</h2>
    <p class="section-note">Measured from the <code>usage</code> object of every call that
      passed through this gateway. Spend excludes blocked and errored calls, which were
      never billed.</p>
    <div class="grid cols-4">${kpis}</div>

    <div class="card" style="margin-top:18px">
      <div class="rail">Daily spend</div>
      <div style="margin-top:14px">${barChart(daily)}</div>
    </div>

    <div class="grid cols-2" style="margin-top:18px">
      <div class="card">${breakdownTable(byModel, "Model")}</div>
      <div class="card">${breakdownTable(byAgent, "Agent")}</div>
    </div>
    <div class="card" style="margin-top:18px">${breakdownTable(byDept, "Department")}</div>`;
}

async function renderAgents() {
  const agents = await api("agents");
  if (agents.length === 0) return emptyState();

  const rows = agents
    .map(
      (a) => `<tr>
        <td><strong>${escapeHtml(a.agentId)}</strong></td>
        <td>${escapeHtml(a.department)}</td>
        <td class="num">${money(a.costUsd)}</td>
        <td class="num">${money(a.costPerCallUsd)}</td>
        <td class="num">${count(a.calls)}</td>
        <td class="num">${count(a.inputTokens + a.outputTokens)}</td>
        <td class="num ${a.cacheHitRatio > 0.3 ? "accent-green" : ""}">${pct(a.cacheHitRatio, 0)}</td>
        <td class="num ${a.errorRate > 0.05 ? "accent-rust" : ""}">${pct(a.errorRate, 0)}</td>
        <td class="num">${a.blockedCalls ? `<span class="accent-rust">${a.blockedCalls}</span>` : "—"}</td>
        <td class="num">${a.lastSeenAt ? relativeTime(a.lastSeenAt) : "—"}</td>
      </tr>`,
    )
    .join("");

  return `
    <h2>Agents</h2>
    <p class="section-note">One row per cost line. Label traffic with the
      <code>x-costgrid-agent</code> header; anything unlabelled arrives as
      <code>unattributed</code>, which is a visible gap rather than a silent one.
      Cost per call counts successful calls only.</p>
    <div class="card scroll-x"><table>
      <thead><tr>
        <th>Agent</th><th>Department</th>
        <th class="num">Cost</th><th class="num">Per call</th><th class="num">Calls</th>
        <th class="num">Tokens</th><th class="num">Cached</th><th class="num">Errors</th>
        <th class="num">Blocked</th><th class="num">Last seen</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

async function renderRouting() {
  const [routing, tiers, overview] = await Promise.all([
    api("routing"),
    api("tiers"),
    api("overview"),
  ]);

  const tierRows = tiers.length
    ? tiers
        .map(
          (t) => `<tr>
            <td>${escapeHtml(t.tier)}</td>
            <td class="num">${count(t.tokens)}</td>
            <td class="num">${money(t.costUsd)}</td>
            <td class="num">${count(t.calls)}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="kpi-sub">Nothing recorded.</td></tr>`;

  const a = routing.assumptions;

  return `
    <h2>Routing</h2>
    <p class="section-note">Your substitution share — the fraction of tokens served off the
      frontier tier — is <strong>measured from traffic</strong>. Everything else on this page
      is a model, and is only as good as the assumptions below it.</p>

    <div class="grid cols-4">
      ${card("Observed share", pct(routing.observedShare), "measured from your calls", "accent-rust")}
      ${card("Modelled optimum", pct(routing.optimalShare), "where marginal saving = marginal risk", "accent-gold")}
      ${card("Modelled headroom", pct(routing.savingFraction, 0), "on the token line, at the optimum")}
      ${card("Projected saving", money(String(overview.routing.projectedSavingUsd)),
        `over this window, if the model holds`)}
    </div>

    <div class="grid cols-2" style="margin-top:18px">
      <div class="card">
        <div class="rail">Blended cost curve</div>
        <div style="margin-top:14px">${curveChart(routing)}</div>
        <div class="legend">
          <span><span class="swatch" style="background:var(--rust)"></span>your traffic</span>
          <span><span class="swatch" style="background:var(--gold)"></span>modelled optimum</span>
        </div>
      </div>
      <div class="card">
        <div class="rail">Tokens by tier</div>
        <div class="scroll-x" style="margin-top:12px"><table>
          <thead><tr>
            <th>Tier</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">Calls</th>
          </tr></thead>
          <tbody>${tierRows}</tbody>
        </table></div>
        <p class="kpi-sub" style="margin-top:16px">
          Assumptions: frontier $${a.frontierCost.toFixed(2)}/Mtok, open floor
          $${a.openCost.toFixed(2)}/Mtok, ${pct(a.overhead, 0)} governance overhead,
          risk penalty k=${a.riskCoefficient} with exponent N=${a.riskExponent}.
          Edit them in <code>packages/core/src/routing.ts</code>.
        </p>
      </div>
    </div>`;
}

async function renderPolicies() {
  const [policies, violations] = await Promise.all([api("policies"), api("violations?limit=25")]);

  const describe = (rule) => {
    if (rule.kind === "budget") return `budget ${money(rule.limitUsd)} per ${rule.window}`;
    if (rule.kind === "max-output-tokens") return `max_tokens ≤ ${count(rule.limit)}`;
    return `${rule.kind}: ${rule.models.map(escapeHtml).join(", ")}`;
  };

  const scopeOf = (scope) =>
    scope.kind === "tenant"
      ? "whole tenant"
      : scope.kind === "agent"
        ? `agent: ${scope.agentId}`
        : `dept: ${scope.department}`;

  const policyRows = policies.length
    ? policies
        .map(
          (p) => `<tr>
            <td><span class="tag ${p.enabled ? "on" : "off"}">${p.enabled ? "on" : "off"}</span></td>
            <td><span class="tag ${p.action}">${p.action}</span></td>
            <td>${escapeHtml(scopeOf(p.scope))}</td>
            <td>${describe(p.rule)}</td>
            <td class="num">
              <button data-toggle="${escapeHtml(p.id)}" data-enabled="${p.enabled}"
                style="font-family:var(--mono);font-size:11px;padding:4px 9px;
                       border:1px solid var(--rule);background:transparent;cursor:pointer">
                ${p.enabled ? "disable" : "enable"}
              </button>
            </td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="kpi-sub">
         No policies. Everything is allowed and metered.
       </td></tr>`;

  const violationRows = violations.length
    ? violations
        .map(
          (v) => `<tr>
            <td class="num" style="text-align:left">${relativeTime(v.occurredAt)}</td>
            <td><span class="tag ${v.action}">${v.action}</span></td>
            <td>${escapeHtml(v.agentId ?? "—")}</td>
            <td>${escapeHtml(v.reason)}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="kpi-sub">No policy events recorded.</td></tr>`;

  return `
    <h2>Policies</h2>
    <p class="section-note">A <strong>block</strong> is evaluated before the request is
      forwarded, so a blocked call costs nothing. <strong>Warn</strong> forwards it and returns
      an <code>x-costgrid-warnings</code> header. <strong>Monitor</strong> only records — start
      there to see what a rule would do before it does it. Add rules with
      <code>costgrid policy</code>.</p>

    <div class="card scroll-x"><table>
      <thead><tr><th></th><th>Action</th><th>Scope</th><th>Rule</th><th></th></tr></thead>
      <tbody>${policyRows}</tbody>
    </table></div>

    <h2 style="margin-top:28px">Enforcement feed</h2>
    <p class="section-note">Every rule that fired, including monitor-only ones.</p>
    <div class="card scroll-x"><table>
      <thead><tr><th>When</th><th>Action</th><th>Agent</th><th>Reason</th></tr></thead>
      <tbody>${violationRows}</tbody>
    </table></div>`;
}

async function renderPricing() {
  const models = await api("models");
  const rows = models
    .map(
      (m) => `<tr>
        <td><strong>${escapeHtml(m.displayName)}</strong><br />
          <span class="kpi-sub"><code>${escapeHtml(m.id)}</code></span></td>
        <td>${escapeHtml(m.tier)}</td>
        <td class="num">$${m.inputPerMTokUsd}</td>
        <td class="num">$${m.outputPerMTokUsd}</td>
        <td class="num">$${m.cacheWrite5mPerMTokUsd}</td>
        <td class="num">$${m.cacheReadPerMTokUsd}</td>
      </tr>`,
    )
    .join("");

  return `
    <h2>Pricing catalog</h2>
    <p class="section-note">Every model CostGrid can price, in $ per million tokens. A call on
      a model <em>not</em> in this list is still metered, but recorded as unpriced — its cost
      reads as zero and totals say so, rather than showing it as free traffic. Prices are
      first-party Anthropic list rates; Bedrock and Vertex are partner-operated and priced
      separately.</p>
    <div class="card scroll-x"><table>
      <thead><tr>
        <th>Model</th><th>Tier</th>
        <th class="num">Input</th><th class="num">Output</th>
        <th class="num">Cache write</th><th class="num">Cache read</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// --------------------------------------------------------------------- shell

const VIEWS = {
  overview: renderOverview,
  agents: renderAgents,
  routing: renderRouting,
  policies: renderPolicies,
  pricing: renderPricing,
};

async function render() {
  const main = document.getElementById("main");
  try {
    main.innerHTML = await VIEWS[state.view]();
    document.getElementById("footer-note").textContent =
      `${state.view} · last ${state.days} day${state.days === 1 ? "" : "s"} · updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    main.innerHTML = `<div class="banner"><strong>Could not load.</strong>
      ${escapeHtml(error.message)}</div>`;
  }
}

document.getElementById("nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button) return;

  state.view = button.dataset.view;
  for (const other of document.querySelectorAll("#nav button")) {
    other.setAttribute("aria-current", String(other === button));
  }
  render();
});

document.getElementById("range").addEventListener("change", (event) => {
  state.days = Number(event.target.value);
  render();
});

// Policy toggles are delegated, since the rows are re-rendered on every load.
document.getElementById("main").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-toggle]");
  if (!button) return;

  button.disabled = true;
  await fetch(`/api/policies/${encodeURIComponent(button.dataset.toggle)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: button.dataset.enabled !== "true" }),
  });
  render();
});

render();
