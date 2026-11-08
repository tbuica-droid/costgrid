/**
 * The console's frame: a sidebar that folds to a rail of icons, a drawer on
 * small screens, and a confirmation dialog that replaces the browser's own.
 *
 * Navigation itself is unchanged: every item here is a `[data-page]` button,
 * which console.js already handles. This file only lays them out.
 */

import { escapeHtml, icon } from "./ui.js";

const FOLDED_KEY = "costgrid:nav-folded";

function remember(folded) {
  try {
    localStorage.setItem(FOLDED_KEY, folded ? "1" : "0");
  } catch {
    // Private windows can refuse storage; the sidebar simply opens unfolded next time.
  }
}

function recalled() {
  try {
    return localStorage.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

export function initShell() {
  const shell = document.querySelector(".shell");
  if (!shell) return;
  shell.classList.toggle("folded", recalled());

  document.addEventListener("click", (event) => {
    if (event.target.closest("#nav-fold")) {
      const folded = !shell.classList.contains("folded");
      shell.classList.toggle("folded", folded);
      document.getElementById("nav-fold")?.setAttribute("aria-expanded", String(!folded));
      remember(folded);
      return;
    }
    if (event.target.closest("#menu-open-top")) {
      document.body.classList.add("nav-open");
      document.querySelector("#nav .nav-item")?.focus();
      return;
    }
    // Choosing a screen, or tapping outside the drawer, closes it.
    if (event.target.closest("#menu-close, .nav-scrim, #nav [data-page]")) {
      document.body.classList.remove("nav-open");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") document.body.classList.remove("nav-open");
  });
}

/**
 * Ask before doing something that is hard to undo. Resolves true on confirm.
 *
 * A native <dialog>: focus moves into it and back, Escape cancels, and a
 * click outside cancels. `tone: "danger"` marks the confirm button red.
 */
export function confirmDialog({ title, body, confirm = "Continue", cancel = "Cancel", tone = "" }) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "dlg";
    dialog.setAttribute("aria-labelledby", "dlg-title");
    dialog.innerHTML = `<form method="dialog">
        <div class="dlg-head"><h2 id="dlg-title">${escapeHtml(title)}</h2>${body ? `<p>${escapeHtml(body)}</p>` : ""}</div>
        <div class="dlg-foot">
          <button value="cancel" class="btn btn-secondary" type="submit">${escapeHtml(cancel)}</button>
          <button value="ok" class="btn ${tone === "danger" ? "btn-danger" : "btn-primary"}" type="submit">${escapeHtml(confirm)}</button>
        </div>
        <button value="cancel" class="dlg-x" type="submit" aria-label="Close">
          <svg viewBox="0 0 17 17" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l9 9M13 4l-9 9"/></svg>
        </button>
      </form>`;
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      if (!inside) dialog.close("cancel");
    });
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    document.body.appendChild(dialog);
    dialog.showModal();
    // Safer default: the cancel button has focus, so Enter never confirms by accident.
    dialog.querySelector('button[value="cancel"]').focus();
  });
}
