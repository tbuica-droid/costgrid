/*
 * Applies the saved appearance before the first paint, so a light-mode user
 * never sees a flash of dark. Loaded first in <head>, as a file because the
 * page's content security policy refuses inline scripts.
 *
 * Settings writes the same key; see setAppearance in ui.js.
 */
(function () {
  var theme = "dark";
  try {
    var saved = localStorage.getItem("cg-appearance");
    if (saved === "light" || saved === "system") theme = saved;
  } catch (error) {
    // Storage blocked: stay dark, the default.
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
