/*
 * Home page hero: starts the background video, served from this site.
 *
 * The headline shows at once, with nothing animated in: the first second on
 * the page is when a visitor decides whether to read on. The video is never
 * loaded for anyone who asked for less motion or to save data; the CSS
 * background shows instead, and the video fades in once it is playing.
 */
(function () {
  var video = document.querySelector(".hero-video");
  if (!video || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (navigator.connection && navigator.connection.saveData) return;
  video.addEventListener("playing", function () { video.classList.add("on"); }, { once: true });
  video.src = video.getAttribute("data-src");
  var playing = video.play();
  if (playing && playing.catch) playing.catch(function () {});
})();
