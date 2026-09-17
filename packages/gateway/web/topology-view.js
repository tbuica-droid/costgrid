/**
 * Topology view: the fleet as extracted from metered traffic.
 *
 * Its own module because app.js is long enough, and because this is the one
 * view with a layout algorithm rather than a table in it.
 *
 * Edge kind carries meaning and is drawn, not merely legended: a tool the
 * agent *used* is a different fact from one it merely *may* use, and a policy
 * has to reason about the second. Used edges are solid, granted ones dashed.
 */

const INK = "#0f1411";
const GOLD = "#9d7b1f";
const RUST = "#a8452a";
const COLOR = { agent: INK, model: GOLD, tool: RUST };

/** Deterministic seeding, so the same fleet lays out the same way each visit. */
function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function layout(nodes, edges, W, H) {
  const rand = makeRandom(11);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const n of nodes) {
    const ring = n.kind === "agent" ? 0.4 : 0.85;
    const angle = rand() * Math.PI * 2;
    n.x = W / 2 + Math.cos(angle) * (W / 2) * ring * 0.8;
    n.y = H / 2 + Math.sin(angle) * (H / 2) * ring * 0.8;
    n.vx = 0;
    n.vy = 0;
    n.r = n.kind === "tool" ? 6 : 8 + Math.sqrt(Number(n.costUsd) || 0) * 1.6;
    n.labelHalf = (n.id.length * 10 * 0.58) / 2;
  }

  const live = edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const ticks = Math.min(600, 200 + nodes.length * 8);

  for (let t = 0; t < ticks; t += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const f = 4200 / d2;
        a.vx -= (dx / d) * f;
        a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f;
        b.vy += (dy / d) * f;
      }
    }
    for (const e of live) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - (e.kind === "delegates" ? 90 : 125)) * 0.016;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.0022;
      n.vy += (H / 2 - n.y) * 0.003;
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x += n.vx;
      n.y += n.vy;
      // Clamp the label, not just the dot: a node against the edge would
      // otherwise render with half its name cut off.
      const padX = Math.max(n.r, n.labelHalf) + 4;
      n.x = Math.max(padX, Math.min(W - padX, n.x));
      n.y = Math.max(n.r + 6, Math.min(H - n.r - 16, n.y));
    }
  }
}

/** Everything `start` reaches, following edges forward. */
export function reachableFrom(edges, start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const at = queue.shift();
    for (const e of edges) {
      if (e.from !== at || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return seen;
}

export function drawTopology(mount, panel, topo, helpers) {
  const { escapeHtml, money, count } = helpers;
  const nodes = topo.nodes.map((n) => ({ ...n }));
  const W = mount.clientWidth < 560 ? 380 : 760;
  const H = mount.clientWidth < 560 ? 560 : 470;
  layout(nodes, topo.edges, W, H);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const NS = "http://www.w3.org/2000/svg";
  const el = (name, attrs) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  mount.innerHTML = "";
  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    style: "display:block;height:auto",
    role: "img",
    "aria-label": "Agent topology extracted from metered traffic",
  });
  const edgeLayer = el("g", {});
  const nodeLayer = el("g", {});
  svg.append(edgeLayer, nodeLayer);

  const drawn = topo.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const edgeEls = drawn.map((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const line = el("line", {
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      stroke: e.kind === "uses" || e.kind === "grants" ? RUST : e.kind === "delegates" ? INK : GOLD,
      "stroke-width": e.kind === "delegates" ? 1.6 : 1.2,
      "stroke-opacity": 0.28,
      // A capability never exercised is drawn as the weaker claim it is.
      ...(e.kind === "grants" ? { "stroke-dasharray": "4 4" } : {}),
    });
    edgeLayer.appendChild(line);
    return line;
  });

  const nodeEls = nodes.map((n) => {
    const g = el("g", { style: "cursor:pointer", tabindex: "0", role: "button", "aria-label": n.id });
    const halo = el("circle", { cx: n.x, cy: n.y, r: n.r + 5, fill: GOLD, "fill-opacity": 0 });
    const dot = el("circle", {
      cx: n.x,
      cy: n.y,
      r: n.r,
      fill: n.kind === "tool" ? "#f5f2e9" : COLOR[n.kind],
      stroke: COLOR[n.kind],
      "stroke-width": 1.4,
    });
    const label = el("text", {
      x: n.x,
      y: n.y + n.r + 13,
      "text-anchor": "middle",
      "font-family": "'Fragment Mono', ui-monospace, monospace",
      "font-size": 10,
      fill: n.kind === "agent" ? INK : "rgba(15,20,17,0.62)",
    });
    label.textContent = n.id;
    g.append(halo, dot, label);
    nodeLayer.appendChild(g);
    return { node: n, g, halo, dot, label };
  });

  mount.appendChild(svg);

  const IDLE = `<div class="kpi-sub" style="line-height:1.7">Select a node to inspect it.<br /><br />
    Solid edges were exercised; dashed ones are capability the agent holds and
    has not used in this window.</div>`;

  let pinned = null;

  function highlight(id) {
    const related = id === null ? null : new Set([id, ...reachableFrom(drawn, id)]);
    if (related !== null) {
      for (const e of drawn) if (e.to === id) related.add(e.from);
    }
    for (const { node, dot, halo, label } of nodeEls) {
      const on = related === null || related.has(node.id);
      dot.setAttribute("fill-opacity", on ? 1 : 0.18);
      dot.setAttribute("stroke-opacity", on ? 1 : 0.18);
      label.setAttribute("opacity", on ? 1 : 0.2);
      halo.setAttribute("fill-opacity", node.id === id ? 0.22 : 0);
    }
    drawn.forEach((e, i) => {
      const on = related === null || (related.has(e.from) && related.has(e.to));
      edgeEls[i].setAttribute("stroke-opacity", on ? (related === null ? 0.28 : 0.6) : 0.06);
    });
  }

  function describe(n) {
    const direct = drawn.filter((e) => e.from === n.id);
    const reach = reachableFrom(drawn, n.id);
    const indirect = [...reach].filter((id) => !direct.some((e) => e.to === id));
    const upstream = drawn.filter((e) => e.to === n.id).map((e) => e.from);

    const row = (k, v) =>
      `<div style="display:flex;justify-content:space-between;gap:14px;padding:7px 0;
                   border-bottom:1px solid var(--rule-soft)">
         <span style="color:var(--muted)">${k}</span><span style="text-align:right">${v}</span></div>`;
    const list = (ids) =>
      ids.length === 0 ? '<span style="color:var(--muted)">none</span>' : ids.map(escapeHtml).join(", ");

    let html = `<div style="font-size:16px;font-weight:600">${escapeHtml(n.id)}</div>
      <div class="rail" style="margin:4px 0 14px">${n.kind}${
        n.department ? ` · ${escapeHtml(n.department)}` : ""
      }</div>`;
    if (n.kind !== "tool") {
      html += row("Spend", money(n.costUsd));
      html += row("Calls", count(n.calls));
    } else {
      html += row("Invocations", count(n.calls));
    }
    if (n.kind === "agent") {
      html += row("Calls directly", list(direct.map((e) => e.to)));
      html += row("Reaches indirectly", list(indirect));
    } else {
      html += row("Reached by", list([...new Set(upstream)]));
    }
    return html;
  }

  function select(n) {
    pinned = n;
    panel.innerHTML = n === null ? IDLE : describe(n);
    highlight(n === null ? null : n.id);
  }

  for (const entry of nodeEls) {
    entry.g.addEventListener("mouseenter", () => {
      if (!pinned) highlight(entry.node.id);
    });
    entry.g.addEventListener("mouseleave", () => {
      if (!pinned) highlight(null);
    });
    entry.g.addEventListener("click", () => select(pinned === entry.node ? null : entry.node));
  }
  svg.addEventListener("click", (event) => {
    if (event.target === svg) select(null);
  });

  select(null);
}
