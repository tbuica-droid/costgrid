/*
 * CostGrid website, motion layer. Pairs with site-motion.css.
 *
 *   - The hero pins while you scroll through it, and its video grows from a
 *     framed card to the whole screen (scroll position drives --p, 0 to 1).
 *     It never takes the wheel or touch away from the browser: scrolling
 *     stays scrolling, which keeps keyboard, trackpad and screen readers
 *     working as they always do.
 *   - Dialogs open with [data-dialog-open] and close on Escape, the close
 *     button or a click outside.
 *   - The dock appears once the hero is behind you and steps aside for the footer.
 *   - The footer rises into view as it is uncovered (--r), and its buttons lean
 *     towards the pointer.
 *
 * Anyone who asks for less motion gets a still page: no pinning, no video,
 * no leaning. Dialogs and the dock still work.
 */
(function () {
  var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(pointer: fine)").matches;
  var clamp = function (v) { return Math.max(0, Math.min(1, v)); };

  // ------------------------------------------------------------- hero
  var hero = document.querySelector(".xhero");
  if (hero && !still) {
    hero.classList.add("pinned");
    var video = hero.querySelector("video[data-src]");
    var saveData = navigator.connection && navigator.connection.saveData;
    if (video && !saveData) {
      video.addEventListener("playing", function () { video.classList.add("on"); }, { once: true });
      video.src = video.getAttribute("data-src");
      var playing = video.play();
      if (playing && playing.catch) playing.catch(function () {});
    }
  }

  // ------------------------------------------------------------- dock and footer
  var dock = document.querySelector(".dock");
  var cine = document.querySelector(".cine");

  var ticking = false;
  function frame() {
    ticking = false;
    var vh = window.innerHeight;
    if (hero && hero.classList.contains("pinned")) {
      var box = hero.getBoundingClientRect();
      var travel = box.height - vh;
      hero.style.setProperty("--p", travel > 0 ? clamp(-box.top / travel).toFixed(4) : "0");
    }
    var footerTop = cine ? cine.getBoundingClientRect().top : Infinity;
    if (cine && !still) cine.style.setProperty("--r", clamp((vh - footerTop) / (vh * 0.8)).toFixed(4));
    if (dock) {
      var past = hero ? hero.getBoundingClientRect().bottom < vh * 0.6 : window.scrollY > vh;
      dock.classList.toggle("shown", past && footerTop > vh * 0.75);
    }
  }
  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(frame); }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  frame();

  // ------------------------------------------------------------- dialogs
  document.addEventListener("click", function (event) {
    var opener = event.target.closest("[data-dialog-open]");
    if (opener) {
      var dlg = document.getElementById(opener.getAttribute("data-dialog-open"));
      if (dlg && typeof dlg.showModal === "function") {
        event.preventDefault();
        var current = opener.closest("dialog");
        if (current && current !== dlg) current.close();
        if (!dlg.open) dlg.showModal();
      }
      return;
    }
    var closer = event.target.closest("[data-dialog-close]");
    if (closer) {
      closer.closest("dialog").close();
      return;
    }
    // A click on the backdrop lands on the dialog element itself.
    if (event.target.tagName === "DIALOG" && event.target.open) {
      var r = event.target.getBoundingClientRect();
      var inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      if (!inside) event.target.close();
    }
  });
  // A link inside a dialog that goes somewhere on this page closes it first.
  document.querySelectorAll("dialog a[href^='#']").forEach(function (a) {
    a.addEventListener("click", function () { a.closest("dialog").close(); });
  });

  // ------------------------------------------------------------- metal buttons
  document.querySelectorAll(".btn-metal").forEach(function (btn) {
    btn.addEventListener("pointerdown", function (event) {
      if (still) return;
      var r = btn.getBoundingClientRect();
      var dot = document.createElement("span");
      dot.className = "ripple";
      dot.style.left = event.clientX - r.left + "px";
      dot.style.top = event.clientY - r.top + "px";
      btn.appendChild(dot);
      setTimeout(function () { dot.remove(); }, 700);
    });
  });

  // ------------------------------------------------------------- magnetic pills
  if (!still && finePointer) {
    document.querySelectorAll("[data-magnetic]").forEach(function (el) {
      el.addEventListener("pointermove", function (event) {
        var r = el.getBoundingClientRect();
        var x = event.clientX - r.left - r.width / 2;
        var y = event.clientY - r.top - r.height / 2;
        el.style.transition = "transform 120ms ease-out";
        el.style.transform = "translate(" + x * 0.3 + "px," + y * 0.3 + "px) scale(1.04)";
      });
      el.addEventListener("pointerleave", function () {
        el.style.transition = "transform 900ms cubic-bezier(0.34, 1.56, 0.64, 1)";
        el.style.transform = "";
      });
    });
  }

  var top = document.querySelector("[data-to-top]");
  if (top) {
    top.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
    });
  }
})();
