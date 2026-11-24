/**
 * Static-hosting shim for the dashboard demo.
 *
 * The dashboard talks to `/api/…`. On GitHub Pages there is no gateway to
 * answer, so this maps each request onto a JSON snapshot captured from a real
 * gateway run. It is a transport swap and nothing more: the dashboard code,
 * the rendering and every figure are unmodified, which is the point — a demo
 * that reimplemented the numbers would prove nothing about the product.
 *
 * Snapshots are frozen, so query parameters (`days`, `limit`) are ignored,
 * except `month`, which selects between the two captured statements. A policy
 * switch is remembered in the browser until reload; the snapshot file is not.
 */
(() => {
  // Policy switches have no server in the static demo. Remember them here so
  // the Policies view can show the change until the page is reloaded.
  const policyEnabled = new Map();

  const SNAPSHOTS = {
    overview: "overview",
    "spend/daily": "spend-daily",
    "spend/by/model": "spend-by-model",
    "spend/by/agent": "spend-by-agent",
    "spend/by/department": "spend-by-department",
    agents: "agents",
    tiers: "tiers",
    routing: "routing",
    savings: "savings",
    models: "models",
    violations: "violations",
    policies: "policies",
    history: "history",
    topology: "topology",
    statement: "statement",
  };

  const realFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = new URL(String(input), location.href);
    // Only the dashboard's own absolute `/api/…` calls are proxied. The
    // relative `./api/…` requests this shim makes, and the CSV it points the
    // download link at, must fall through to the real fetch or they would be
    // answered with a snapshot lookup for a file that is right there.
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);

    const route = url.pathname.slice(5);
    let file = SNAPSHOTS[route];

    if (route === "statement") {
      const month = url.searchParams.get("month");
      // Only the two captured months exist; anything else falls back to the
      // current one rather than 404ing the whole view.
      file = month === "2026-08" ? "statement-2026-08" : "statement";
    }

    if ((init?.method ?? "GET") === "PATCH" && route.startsWith("policies/")) {
      const id = decodeURIComponent(route.slice("policies/".length));
      let enabled;
      try {
        const body = JSON.parse(init?.body ?? "{}");
        if (typeof body.enabled === "boolean") enabled = body.enabled;
      } catch {
        enabled = undefined;
      }
      if (enabled === undefined) {
        return new Response(JSON.stringify({ error: "enabled must be true or false" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      policyEnabled.set(id, enabled);
      return new Response(JSON.stringify({ ok: true, id, enabled }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (file === undefined) {
      return new Response(JSON.stringify({ error: `not in this demo: ${route}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    const response = await realFetch(`./api/${file}.json`, { cache: "no-cache" });
    if (route !== "policies" || policyEnabled.size === 0) return response;
    const policies = await response.json();
    if (!Array.isArray(policies)) return response;
    return new Response(
      JSON.stringify(policies.map((policy) => (
        policyEnabled.has(policy.id) ? { ...policy, enabled: policyEnabled.get(policy.id) } : policy
      ))),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  /*
   * The CSV export is a plain link, not a fetch, so the shim above never sees
   * it. Take the click and send the browser to the captured file instead —
   * rewriting `href` mid-click would leave it to the browser whether the old
   * or new value wins, and the download is the whole reason the Statement tab
   * exists for a finance reader.
   */
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.('a[href*="/api/statement.csv"]');
    if (!link) return;
    event.preventDefault();
    const month = new URL(link.href, location.href).searchParams.get("month");
    location.href = month === "2026-08" ? "./api/statement-2026-08.csv" : "./api/statement.csv";
  });
})();
