/*
 * The "what it is" diagram on the home page: one call travelling through
 * CostGrid, then a second one that is over its team's limit and stopped.
 *
 * Every step sets the whole picture from scratch, so pausing, resuming or
 * starting part-way through can never leave it half drawn. The diagram is
 * hidden from screen readers; the same steps are in a plain list next to it.
 * With reduced motion, it starts paused on a single complete frame.
 */
(function () {
  var root = document.getElementById("flow");
  if (!root) return;

  function el(id) { return document.getElementById(id); }
  var pkt1 = el("pkt1"), pkt2 = el("pkt2");
  var nodeApp = el("nodeApp"), nodeCg = el("nodeCg"), nodeAi = el("nodeAi");
  var checks = [el("chkPrice"), el("chkTeam"), el("chkCap")];
  var capVal = el("capVal"), verdict = el("flowVerdict"), keyChip = el("keyChip");
  var caption = el("flowCaption"), counter = el("flowStep"), toggle = el("flowToggle");

  var timers = [];
  function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  // Put a dot at one end of its wire without animating, then show it.
  function jump(p, at, kind) {
    p.className = "pkt jump show" + (kind ? " " + kind : "");
    p.style.setProperty("--t", String(at));
    void p.offsetWidth; // apply the position before transitions come back
    p.classList.remove("jump");
  }
  function move(p, to) { p.style.setProperty("--t", String(to)); }
  function hide(p) { p.classList.remove("show"); }

  function setChecks(count, capState) {
    checks.forEach(function (c, i) {
      c.classList.toggle("on", i < count);
      c.classList.remove("ok", "bad");
    });
    if (count >= 3 && capState) checks[2].classList.add(capState);
  }
  function revealChecks(capState) {
    setChecks(0);
    later(150, function () { setChecks(1); });
    later(650, function () { setChecks(2); });
    later(1150, function () { setChecks(3, capState); });
  }
  function setVerdict(text, kind) {
    verdict.textContent = text;
    verdict.className = "verdict" + (kind ? " " + kind : "");
  }
  function base(cap) {
    [nodeApp, nodeCg, nodeAi].forEach(function (n) { n.classList.remove("lit", "dim"); });
    keyChip.classList.remove("lit");
    capVal.textContent = cap;
    hide(pkt1); hide(pkt2);
    setChecks(0);
    setVerdict("");
  }

  var steps = [
    {
      ms: 2400,
      run: function () {
        base("$312 of $500");
        nodeApp.classList.add("lit");
        jump(pkt1, 0);
        later(200, function () { move(pkt1, 1); });
        later(1300, function () { hide(pkt1); nodeApp.classList.remove("lit"); nodeCg.classList.add("lit"); });
      }
    },
    {
      ms: 2600,
      run: function () {
        base("$312 of $500");
        nodeCg.classList.add("lit");
        revealChecks("ok");
      }
    },
    {
      ms: 2600,
      run: function () {
        base("$312 of $500");
        setChecks(3, "ok");
        setVerdict("Under the limit. Sent.", "ok");
        keyChip.classList.add("lit");
        jump(pkt2, 0);
        later(200, function () { move(pkt2, 1); });
        later(1300, function () { hide(pkt2); nodeAi.classList.add("lit"); });
      }
    },
    {
      ms: 3000,
      run: function () {
        base("$312 of $500");
        setChecks(3, "ok");
        setVerdict("Under the limit. Sent.", "ok");
        jump(pkt2, 1, "ans");
        later(150, function () { move(pkt2, 0); });
        later(1150, function () { hide(pkt2); jump(pkt1, 1, "ans"); });
        later(1300, function () { move(pkt1, 0); });
        later(2300, function () { hide(pkt1); nodeApp.classList.add("lit"); });
      }
    },
    {
      ms: 2600,
      run: function () {
        base("$500 of $500");
        nodeApp.classList.add("lit");
        jump(pkt1, 0);
        later(200, function () { move(pkt1, 1); });
        later(1300, function () { hide(pkt1); nodeApp.classList.remove("lit"); nodeCg.classList.add("lit"); });
      }
    },
    {
      ms: 3000,
      run: function () {
        base("$500 of $500");
        nodeCg.classList.add("lit");
        nodeAi.classList.add("dim");
        revealChecks("bad");
        later(1500, function () { setVerdict("Over the limit. Not sent.", "bad"); });
      }
    },
    {
      ms: 3800,
      run: function () {
        base("$500 of $500");
        nodeAi.classList.add("dim");
        setChecks(3, "bad");
        setVerdict("Over the limit. Not sent.", "bad");
        jump(pkt1, 1, "stop");
        later(150, function () { move(pkt1, 0); });
        later(1150, function () { hide(pkt1); nodeApp.classList.add("lit"); });
      }
    }
  ];

  // The captions live in the page, in the list screen readers get.
  var captions = Array.prototype.map.call(document.querySelectorAll("#flowSteps li"), function (li) {
    return li.textContent;
  });

  var current = 0;
  var playing = false;
  var visible = false;
  var advance = null;

  function show(i) {
    clearTimers();
    current = (i + steps.length) % steps.length;
    caption.textContent = captions[current] || "";
    counter.textContent = current + 1 + " / " + steps.length;
    steps[current].run();
    if (playing && visible) {
      advance = setTimeout(function () { show(current + 1); }, steps[current].ms);
    }
  }
  function stop() {
    clearTimeout(advance);
    clearTimers();
  }
  function setPlaying(on) {
    playing = on;
    toggle.textContent = on ? "Pause" : "Play";
    toggle.setAttribute("aria-label", on ? "Pause the animation" : "Play the animation");
    stop();
    if (on && visible) show(current);
  }

  // A still frame that tells the whole story on its own: priced, checked, sent.
  function still() {
    stop();
    current = 2;
    caption.textContent = captions[2] || "";
    counter.textContent = "3 / " + steps.length;
    base("$312 of $500");
    setChecks(3, "ok");
    setVerdict("Under the limit. Sent.", "ok");
    keyChip.classList.add("lit");
    nodeAi.classList.add("lit");
  }

  toggle.addEventListener("click", function () { setPlaying(!playing); });

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  still();
  setPlaying(false);

  if (!("IntersectionObserver" in window)) {
    // Nothing to tell us when it is on screen: play only when asked.
    visible = true;
    return;
  }
  var started = false;
  new IntersectionObserver(function (entries) {
    visible = entries[0].isIntersecting;
    if (visible && !started && !reduce) {
      // Start from the beginning the first time it scrolls into view.
      started = true;
      current = 0;
      setPlaying(true);
    } else if (playing) {
      // Off screen it stops; back on screen it replays the step it was on.
      stop();
      if (visible) show(current);
    }
  }, { threshold: 0.35 }).observe(root);
})();
