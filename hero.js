/*
 * Home page hero: the heading arrives letter by letter, then the lines under
 * it fade in (timings in index.html, as --delay on each .fade).
 *
 * Loaded straight after the heading, not deferred, so the letters are hidden
 * before the first paint rather than flashing in and out. Without this file,
 * or for anyone who has asked for less motion, everything is simply shown.
 */
(function () {
  var title = document.getElementById("heroTitle");
  var hero = title && title.closest(".hero");
  if (!hero || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var START_MS = 200;
  var CHAR_MS = 30;

  // Screen readers get the sentence once; the letters are decoration.
  var text = title.textContent.trim();
  title.setAttribute("aria-label", text);
  title.textContent = "";

  var index = 0;
  title.getAttribute("data-lines").split("|").forEach(function (line) {
    var lineEl = document.createElement("span");
    lineEl.className = "line";
    lineEl.setAttribute("aria-hidden", "true");
    line.split(" ").forEach(function (word, w) {
      if (w > 0) lineEl.appendChild(document.createTextNode(" "));
      // Letters sit inside their word, so a line only ever breaks between words.
      var wordEl = document.createElement("span");
      wordEl.className = "word";
      for (var c = 0; c < word.length; c += 1) {
        var ch = document.createElement("span");
        ch.className = "ch";
        ch.textContent = word[c];
        ch.style.transitionDelay = START_MS + index * CHAR_MS + "ms";
        wordEl.appendChild(ch);
        index += 1;
      }
      index += 1; // the space takes a beat too
      lineEl.appendChild(wordEl);
    });
    title.appendChild(lineEl);
  });

  hero.classList.add("animate");
  // Two frames, so the hidden state is painted before the transition starts;
  // the timer is the backstop if frames are held back, so the text never stays hidden.
  var reveal = function () { hero.classList.add("in"); };
  requestAnimationFrame(function () { requestAnimationFrame(reveal); });
  setTimeout(reveal, 100);
})();
