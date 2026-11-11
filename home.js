/*
 * Home page behaviour: the request feed in the hero, the savings spotlight,
 * the code tabs, old #pricing / #privacy links, and sections rising in.
 * Every moving part checks first whether the visitor asked for less motion.
 */
(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The request-path diagram animates with SVG; stop it for reduced motion.
  document.querySelectorAll("svg.gw-flow").forEach(function (svg) {
    if (reduce && svg.pauseAnimations) svg.pauseAnimations();
  });

  // Request feed (after Streaming Data Rows by rmahammad). Example traffic,
  // priced at OpenAI's and Anthropic's list rates.
  var ROWS = [
    { a: "Support replies", m: "claude-sonnet-5", r: "Cached prompt", was: 0.0410, now: 0.0122 },
    { a: "Nightly summaries", m: "gpt-6.1-sol", r: "Batch, half price", was: 0.1020, now: 0.0510 },
    { a: "Ticket triage", m: "claude-haiku-4-5", r: "Smaller model, on trial", was: 0.0235, now: 0.0047 },
    { a: "Blog drafts", m: "claude-sonnet-5", r: "Priced", t: "none", now: 0.0186 },
    { a: "Lead research", m: "gpt-6.1-sol", r: "Effort high → medium", was: 0.0700, now: 0.0350 },
    { a: "Invoice entry", m: "claude-sonnet-5", r: "Blocked: daily budget", t: "block", now: 0 },
    { a: "Support replies", m: "claude-sonnet-5", r: "Cached prompt", was: 0.0388, now: 0.0116 },
    { a: "Code review", m: "gpt-6.1-terra", r: "Priced", t: "none", now: 0.0091 }
  ];
  var feed = document.querySelector("[data-feed]");
  if (feed) {
    var body = feed.querySelector(".feed-body");
    var out = { n: feed.querySelector("[data-n]"), s: feed.querySelector("[data-s]"), b: feed.querySelector("[data-b]") };
    var total = { n: 0, s: 0, b: 0 }, next = 0, timer = null, VISIBLE = 5;
    var money = function (v) { return "$" + v.toFixed(4); };
    var cell = function (cls, text) { var s = document.createElement("span"); s.className = cls; s.setAttribute("role", "cell"); s.textContent = text; return s; };
    var make = function (row) {
      var el = document.createElement("div");
      el.className = "feed-row";
      el.setAttribute("role", "row");
      el.appendChild(cell("a", row.a));
      el.appendChild(cell("m", row.m));
      var applied = cell("r " + (row.t || ""), row.r);
      applied.insertBefore(document.createElement("b"), applied.firstChild);
      el.appendChild(applied);
      var cost = cell("c", "");
      var now = document.createElement("span");
      now.textContent = row.t === "block" ? "$0.00" : money(row.now);
      if (!row.was) now.className = "plain";
      if (row.was) { var was = document.createElement("s"); was.textContent = money(row.was); cost.appendChild(was); }
      cost.appendChild(now);
      if (row.t === "block") { var note = document.createElement("em"); note.textContent = "not sent"; cost.appendChild(note); }
      el.appendChild(cost);
      return el;
    };
    var push = function (animate) {
      var row = ROWS[next % ROWS.length]; next += 1;
      var el = make(row);
      if (animate) el.classList.add("enter");
      body.insertBefore(el, body.firstChild);
      if (animate) requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove("enter"); }); });
      while (body.children.length > VISIBLE + 1) body.removeChild(body.lastChild);
      total.n += 1;
      if (row.was) total.s += row.was - row.now;
      if (row.t === "block") total.b += 1;
      out.n.textContent = total.n.toLocaleString("en-GB");
      out.s.textContent = "$" + total.s.toFixed(4);
      out.b.textContent = String(total.b);
    };
    for (var k = 0; k < VISIBLE; k++) push(false);
    if (!reduce && "IntersectionObserver" in window) {
      var visible = false;
      var run = function () { if (!timer && visible && !document.hidden) timer = setInterval(function () { push(true); }, 2200); };
      var stop = function () { clearInterval(timer); timer = null; };
      new IntersectionObserver(function (es) { visible = es[0].isIntersecting; visible ? run() : stop(); }).observe(feed);
      document.addEventListener("visibilitychange", function () { document.hidden ? stop() : run(); });
    }
  }

  // Savings grid: a soft light follows the pointer (after Hirael's Feature 08).
  document.querySelectorAll(".sv").forEach(function (el) {
    el.addEventListener("pointermove", function (e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty("--mx", (e.clientX - r.left) + "px");
      el.style.setProperty("--my", (e.clientY - r.top) + "px");
    });
  });

  // Tabs, with arrow keys.
  document.querySelectorAll("[role=tablist]").forEach(function (list) {
    var tabs = [].slice.call(list.querySelectorAll("[role=tab]"));
    var select = function (t) {
      tabs.forEach(function (x) {
        var on = x === t;
        x.setAttribute("aria-selected", String(on));
        x.tabIndex = on ? 0 : -1;
        document.getElementById(x.getAttribute("aria-controls")).hidden = !on;
      });
    };
    tabs.forEach(function (t, n) {
      t.addEventListener("click", function () { select(t); });
      t.addEventListener("keydown", function (e) {
        var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var to = tabs[(n + d + tabs.length) % tabs.length];
        select(to); to.focus();
      });
    });
  });

  // Copy the highlighted lines of the visible code panel.
  document.querySelectorAll(".copy").forEach(function (b) {
    b.addEventListener("click", function () {
      var panel = b.closest(".code").querySelector("[role=tabpanel]:not([hidden])");
      var text = [].map.call(panel.querySelectorAll("[data-copy]"), function (x) { return x.textContent; }).join("\n");
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(function () {
        b.textContent = "Copied";
        setTimeout(function () { b.textContent = "Copy"; }, 1600);
      }, function () {});
    });
  });

  // Old links to #pricing and #privacy now land on a question: open it.
  var openFromHash = function () {
    var id = location.hash.slice(1);
    var el = id && document.getElementById(id);
    if (el && el.tagName === "DETAILS") el.open = true;
  };
  openFromHash();
  window.addEventListener("hashchange", openFromHash);

  // Sections rise in once. Anything on screen at load is left alone, so nothing flashes.
  if (!reduce && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px" });
    document.querySelectorAll(".rise").forEach(function (el) {
      if (el.getBoundingClientRect().top > window.innerHeight) { el.classList.add("pre"); io.observe(el); }
    });
  }
})();
