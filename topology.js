/**
 * Agent topology preview for the CostGrid site.
 *
 * Shows the shape stage 1 extracts from metered traffic: which agents call
 * which models, which tools they can reach, and who delegates to whom.
 *
 * Provenance is drawn, not just claimed. Solid edges are EXTRACTED — they come
 * from the demo's real metered calls. Dashed edges are ILLUSTRATIVE: tool and
 * delegation edges need the run/tool-call extraction that ships next, so they
 * are drawn as an example rather than presented as measurement. Keeping the two
 * visually distinct is the same discipline the product applies to realised
 * versus dry-run savings, and it is the point of the picture as much as the
 * topology is.
 *
 * No library: ~20 nodes do not justify a CDN dependency on a page that has
 * none, and the force model is thirty lines.
 */
(() => {
  const mount = document.getElementById("topology");
  if (!mount) return;

  // --- data ---------------------------------------------------------------
  // Agents and models carry the demo snapshot's real figures. Tools and
  // delegations are illustrative — flagged below and in the legend.
  const NODES = [
    { id: "chat-bot",         kind: "agent", dept: "Support",     cost: 7.38, calls: 83 },
    { id: "code-review",      kind: "agent", dept: "Engineering", cost: 5.11, calls: 48 },
    { id: "ticket-triage",    kind: "agent", dept: "Support",     cost: 4.20, calls: 190 },
    { id: "lint-bot",         kind: "agent", dept: "Engineering", cost: 3.08, calls: 142 },
    { id: "docs-writer",      kind: "agent", dept: "Marketing",   cost: 1.80, calls: 40 },
    { id: "unattributed",     kind: "agent", dept: "Unassigned",  cost: 0.82, calls: 23 },

    { id: "claude-opus-5",    kind: "model", cost: 12.35, calls: 114 },
    { id: "claude-haiku-4-5", kind: "model", cost: 7.53,  calls: 349 },
    { id: "claude-sonnet-5",  kind: "model", cost: 1.70,  calls: 39 },
    { id: "gpt-5",            kind: "model", cost: 0.82,  calls: 23 },

    { id: "search_kb",        kind: "tool" },
    { id: "create_ticket",    kind: "tool" },
    { id: "read_crm",         kind: "tool" },
    { id: "query_db",         kind: "tool" },
    { id: "run_tests",        kind: "tool" },
    { id: "post_comment",     kind: "tool" },
    { id: "send_email",       kind: "tool", sensitive: true },
    { id: "refund_customer",  kind: "tool", sensitive: true },
  ];

  const EDGES = [
    // Extracted: every one of these is in the demo's metered calls.
    { from: "chat-bot",      to: "claude-opus-5",    kind: "invokes", extracted: true },
    { from: "chat-bot",      to: "claude-haiku-4-5", kind: "invokes", extracted: true },
    { from: "code-review",   to: "claude-opus-5",    kind: "invokes", extracted: true },
    { from: "ticket-triage", to: "claude-haiku-4-5", kind: "invokes", extracted: true },
    { from: "lint-bot",      to: "claude-haiku-4-5", kind: "invokes", extracted: true },
    { from: "docs-writer",   to: "claude-sonnet-5",  kind: "invokes", extracted: true },
    { from: "unattributed",  to: "gpt-5",            kind: "invokes", extracted: true },

    // Illustrative: tool reach, pending tool-call extraction.
    { from: "chat-bot",      to: "search_kb",       kind: "uses" },
    { from: "chat-bot",      to: "read_crm",        kind: "uses" },
    { from: "ticket-triage", to: "create_ticket",   kind: "uses" },
    { from: "ticket-triage", to: "query_db",        kind: "uses" },
    { from: "ticket-triage", to: "refund_customer", kind: "uses" },
    { from: "docs-writer",   to: "search_kb",       kind: "uses" },
    { from: "docs-writer",   to: "query_db",        kind: "uses" },
    { from: "code-review",   to: "run_tests",       kind: "uses" },
    { from: "code-review",   to: "post_comment",    kind: "uses" },
    { from: "lint-bot",      to: "post_comment",    kind: "uses" },
    { from: "unattributed",  to: "send_email",      kind: "uses" },

    // Illustrative: delegation, pending run extraction.
    { from: "chat-bot",    to: "ticket-triage", kind: "delegates" },
    { from: "code-review", to: "lint-bot",      kind: "delegates" },
  ];

  const INK = "#0f1411", GOLD = "#9d7b1f", RUST = "#a8452a";
  const COLOR = { agent: INK, model: GOLD, tool: RUST };

  const byId = new Map(NODES.map((n) => [n.id, n]));

  /*
   * The viewBox has to suit the space it lands in. A 760-wide box inside a
   * 340px phone column scales to 0.45, which renders a 10px label at four and
   * a half pixels — present, unreadable, worse than absent. Narrow screens get
   * a portrait box instead, so the drawing scales near 1:1 and the type stays
   * the size it claims to be.
   */
  const narrow = (mount.clientWidth || 760) < 560;
  const W = narrow ? 380 : 760;
  const H = narrow ? 560 : 460;
  const FONT = { agent: narrow ? 11 : 12, other: narrow ? 10 : 11 };

  // --- reachability -------------------------------------------------------
  /**
   * Everything `start` can reach, following edges forward.
   *
   * This is the query flat policy cannot express: a rule that names a tool has
   * to account for agents that reach it *through* a delegation, not only those
   * that call it directly.
   */
  function reaches(start) {
    const seen = new Set();
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.shift();
      for (const e of EDGES) {
        if (e.from !== at || seen.has(e.to)) continue;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
    return seen;
  }

  /** Everything that can reach `target`, following edges backward. */
  function reachedBy(target) {
    const seen = new Set();
    const queue = [target];
    while (queue.length > 0) {
      const at = queue.shift();
      for (const e of EDGES) {
        if (e.to !== at || seen.has(e.from)) continue;
        seen.add(e.from);
        queue.push(e.from);
      }
    }
    return seen;
  }

  // --- layout -------------------------------------------------------------
  // Plain force-directed relaxation: repulsion between every pair, springs
  // along edges, a weak pull to centre. Deterministic seeding so the picture
  // is the same for every visitor and in every screenshot.
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (const n of NODES) {
    const ring = n.kind === "agent" ? 0.42 : n.kind === "model" ? 0.86 : 0.92;
    const angle = rand() * Math.PI * 2;
    n.x = W / 2 + Math.cos(angle) * (W / 2) * ring * 0.8;
    n.y = H / 2 + Math.sin(angle) * (H / 2) * ring * 0.8;
    n.vx = 0;
    n.vy = 0;
    const scale = narrow ? 0.78 : 1;
    n.r = (n.kind === "tool" ? 7 : 9 + Math.sqrt(n.cost || 0) * 2.6) * scale;
    // Clamping the centre is not enough: the label is far wider than the dot,
    // so a node parked against the edge renders as "e-review". Reserve half a
    // label either side. 0.58em per character is close enough for a mono face.
    const font = n.kind === "agent" ? FONT.agent : FONT.other;
    n.labelHalf = (n.id.length * font * 0.58) / 2;
  }

  function tick() {
    for (let i = 0; i < NODES.length; i += 1) {
      for (let j = i + 1; j < NODES.length; j += 1) {
        const a = NODES[i], b = NODES[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = rand() - 0.5; dy = rand() - 0.5; d2 = 1; }
        const force = (narrow ? 2600 : 5200) / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force, fy = (dy / d) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    for (const e of EDGES) {
      const a = byId.get(e.from), b = byId.get(e.to);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      // Delegation edges sit shorter, so related agents cluster.
      const rest = (e.kind === "delegates" ? 90 : 128) * (narrow ? 0.62 : 1);
      const force = (d - rest) * 0.016;
      const fx = (dx / d) * force, fy = (dy / d) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    for (const n of NODES) {
      n.vx += (W / 2 - n.x) * 0.0022;
      n.vy += (H / 2 - n.y) * 0.0032;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx; n.y += n.vy;
      const padX = Math.max(n.r, n.labelHalf) + 4;
      // The label sits below the dot, so the bottom needs more room than the top.
      n.x = Math.max(padX, Math.min(W - padX, n.x));
      n.y = Math.max(n.r + 6, Math.min(H - n.r - 18, n.y));
    }
  }

  for (let i = 0; i < 420; i += 1) tick();

  // --- render -------------------------------------------------------------
  const NS = "http://www.w3.org/2000/svg";
  const el = (name, attrs) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    role: "img",
    "aria-label": "Agent topology: agents, the models they call and the tools they can reach",
    style: "display:block;height:auto;touch-action:pan-y",
  });

  const edgeLayer = el("g", {});
  const nodeLayer = el("g", {});
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  const edgeEls = EDGES.map((e) => {
    const a = byId.get(e.from), b = byId.get(e.to);
    const line = el("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: e.kind === "uses" ? RUST : e.kind === "delegates" ? INK : GOLD,
      "stroke-width": e.kind === "delegates" ? 1.6 : 1.2,
      "stroke-opacity": 0.28,
      ...(e.extracted ? {} : { "stroke-dasharray": "4 4" }),
    });
    edgeLayer.appendChild(line);
    return line;
  });

  const nodeEls = NODES.map((n) => {
    const g = el("g", { style: "cursor:pointer", tabindex: "0", role: "button",
                        "aria-label": `${n.id}, ${n.kind}` });
    const halo = el("circle", { cx: n.x, cy: n.y, r: n.r + 5, fill: GOLD, "fill-opacity": 0 });
    const dot = el("circle", {
      cx: n.x, cy: n.y, r: n.r,
      fill: n.kind === "tool" ? "#f5f2e9" : COLOR[n.kind],
      stroke: COLOR[n.kind],
      "stroke-width": n.sensitive ? 2.4 : 1.4,
      ...(n.sensitive ? { "stroke-dasharray": "3 2" } : {}),
    });
    const label = el("text", {
      x: n.x, y: n.y + n.r + 13,
      "text-anchor": "middle",
      "font-family": "'Fragment Mono', ui-monospace, monospace",
      "font-size": n.kind === "agent" ? FONT.agent : FONT.other,
      fill: n.kind === "agent" ? INK : "rgba(15,20,17,0.62)",
    });
    label.textContent = n.id;
    g.append(halo, dot, label);
    nodeLayer.appendChild(g);
    return { node: n, g, halo, dot, label };
  });

  mount.appendChild(svg);

  // --- interaction --------------------------------------------------------
  const panel = document.getElementById("topology-panel");
  let pinned = null;

  const money = (v) => (v === undefined ? "—" : `$${v.toFixed(2)}`);

  function describe(n) {
    const forward = reaches(n.id);
    const direct = new Set(EDGES.filter((e) => e.from === n.id).map((e) => e.to));
    const indirect = [...forward].filter((id) => !direct.has(id));
    const sensitive = [...forward].filter((id) => byId.get(id)?.sensitive);
    const upstream = reachedBy(n.id);

    const row = (k, v) =>
      `<div style="display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px solid rgba(15,20,17,0.1)">
         <span style="color:rgba(15,20,17,0.6)">${k}</span><span>${v}</span></div>`;

    const list = (ids) =>
      ids.length === 0
        ? '<span style="color:rgba(15,20,17,0.45)">none</span>'
        : ids.map((id) => `<span style="white-space:nowrap">${id}</span>`).join(", ");

    let html = `<div style="font-size:16px;font-weight:600;margin-bottom:4px">${n.id}</div>
      <div style="font-family:'Fragment Mono',monospace;font-size:10.5px;letter-spacing:0.1em;
                  text-transform:uppercase;color:rgba(15,20,17,0.5);margin-bottom:14px">
        ${n.kind}${n.dept ? ` &middot; ${n.dept}` : ""}</div>`;

    if (n.kind !== "tool") {
      html += row("Metered spend", money(n.cost));
      html += row("Calls", n.calls);
    }
    if (n.kind === "agent") {
      html += row("Calls directly", list([...direct]));
      html += row("Reaches via delegation", list(indirect));
    } else {
      html += row("Reached by", list([...upstream]));
    }

    if (sensitive.length > 0 && n.kind === "agent") {
      html += `<div style="margin-top:14px;border-left:2px solid ${RUST};padding:8px 0 8px 14px">
        <div style="font-family:'Fragment Mono',monospace;font-size:10.5px;letter-spacing:0.1em;
                    text-transform:uppercase;color:${RUST};margin-bottom:6px">Blast radius</div>
        <div style="font-size:14px;line-height:1.55;color:rgba(15,20,17,0.75)">
          Can reach <strong>${list(sensitive)}</strong>${
            [...direct].some((d) => byId.get(d)?.sensitive)
              ? "."
              : " — not directly, but through an agent it delegates to."
          }</div></div>`;
    }
    return html;
  }

  const IDLE = `<div style="font-family:'Fragment Mono',monospace;font-size:11px;line-height:1.7;
                            color:rgba(15,20,17,0.55)">
      Select a node to inspect it.<br /><br />
      Agents are filled, models gold, tools hollow. A dashed ring marks a tool
      worth a policy. Try <strong style="color:#0f1411">chat-bot</strong>.
    </div>`;

  function highlight(id) {
    const related = id === null ? null : new Set([id, ...reaches(id), ...reachedBy(id)]);
    for (const { node, dot, halo, label } of nodeEls) {
      const on = related === null || related.has(node.id);
      dot.setAttribute("fill-opacity", on ? 1 : 0.18);
      dot.setAttribute("stroke-opacity", on ? 1 : 0.18);
      label.setAttribute("opacity", on ? 1 : 0.2);
      halo.setAttribute("fill-opacity", node.id === id ? 0.22 : 0);
    }
    EDGES.forEach((e, i) => {
      const on = related === null || (related.has(e.from) && related.has(e.to));
      edgeEls[i].setAttribute("stroke-opacity", on ? (related === null ? 0.28 : 0.6) : 0.06);
    });
  }

  function select(n) {
    pinned = n;
    panel.innerHTML = n === null ? IDLE : describe(n);
    highlight(n === null ? null : n.id);
  }

  for (const entry of nodeEls) {
    const { node, g } = entry;
    g.addEventListener("mouseenter", () => { if (!pinned) highlight(node.id); });
    g.addEventListener("mouseleave", () => { if (!pinned) highlight(null); });
    g.addEventListener("click", () => select(pinned === node ? null : node));
    g.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(pinned === node ? null : node); }
    });
  }

  svg.addEventListener("click", (ev) => { if (ev.target === svg) select(null); });
  select(null);
})();
