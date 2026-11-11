/*
 * Home page hero: starts the background video, served from this site.
 *
 * The headline and the request pane show at once; the video is fetched only
 * after the page has loaded, so it never competes with the text. It is never
 * loaded for anyone who asked for less motion or to save data: the CSS
 * backdrop shows instead, and the video fades in once it is playing.
 */
(function () {
  var video = document.querySelector(".hero-video");
  if (!video || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (navigator.connection && navigator.connection.saveData) return;
  function start() {
    video.addEventListener("playing", function () { video.classList.add("on"); }, { once: true });
    video.src = video.getAttribute("data-src");
    var playing = video.play();
    if (playing && playing.catch) playing.catch(function () {});
  }
  if (document.readyState === "complete") setTimeout(start, 200);
  else window.addEventListener("load", function () { setTimeout(start, 200); }, { once: true });
})();
