/**
 * The console's frame: a sidebar that folds to a rail of icons, a drawer on
 * small screens, a dock of the screens people use most, and a confirmation
 * dialog that replaces the browser's own.
 *
 * Navigation itself is unchanged: every item here is a `[data-page]` button,
 * which console.js already handles. This file only lays them out.
 */

import { escapeHtml, icon } from "./ui.js";

const FOLDED_KEY = "costgrid:nav-folded";

/** The screens on the dock, in order. The rest stay in the sidebar and the drawer. */
const DOCK = ["results", "advice", "limits", "setup"];

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
    if (event.target.closest("#menu-open, #menu-open-top")) {
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

/** The dock: the most used screens, one tap away, plus the full menu on small screens. */
export function renderDock(pages, current, signedIn) {
  const dock = document.getElementById("dock");
  if (!dock) return;
  if (!signedIn) {
    dock.hidden = true;
    dock.innerHTML = "";
    return;
  }
  const labels = new Map(pages.map(([id, label]) => [id, label]));
  dock.hidden = false;
  dock.innerHTML =
    DOCK.filter((id) => labels.has(id))
      .map(
        (id) => `<button type="button" class="dock-item" data-page="${id}" aria-current="${id === current}"
          aria-label="${escapeHtml(labels.get(id))}">${icon(id)}<span class="dock-tip">${escapeHtml(labels.get(id))}</span></button>`,
      )
      .join("") +
    `<button type="button" class="dock-item dock-menu" id="menu-open" aria-label="All screens">
      <svg class="icon" viewBox="0 0 17 17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 5h11M3 8.5h11M3 12h11"/></svg>
      <span class="dock-tip">All screens</span></button>`;
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
