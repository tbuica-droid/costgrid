/**
 * Shared bits of the console's markup.
 *
 * Their own file so that `console.js` and `console-security.js` can both use
 * them without importing each other. A cycle between those two would work
 * today and break the first time one of them moved a call to module scope.
 *
 * Every helper here returns markup with classes from styles.css and no inline
 * styles, so the look lives in one place and follows the light/dark setting.
 */

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

export const money = (decimalString) => `$${Number(decimalString).toFixed(2)}`;
export const count = (n) => n.toLocaleString("en-US");

export function relativeTime(timestamp) {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function field(label, name, type = "text", extra = "") {
  return `<label class="field">
    <span class="field-label">${escapeHtml(label)}</span>
    <input name="${name}" type="${type}" ${extra} />
  </label>`;
}

/**
 * A pill button. `primary` is the accent; use it for the one main action in a
 * group. `secondary` is the plain outline `.btn` itself.
 */
export function button(text, attrs = "", variant = "primary") {
  const tone = variant === "secondary" ? "" : ` btn-${variant}`;
  return `<button class="btn${tone}" ${attrs}>${escapeHtml(text)}</button>`;
}

/**
 * The header every screen opens with: a title, the line under it, and the
 * screen's actions on the right. `note` and `actions` are markup.
 */
export function pageHead(title, note = "", actions = "") {
  return `<div class="page-head">
    <div class="page-head-text">
      <h1>${escapeHtml(title)}</h1>
      ${note ? `<p class="page-sub">${note}</p>` : ""}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ""}
  </div>`;
}

// ------------------------------------------------------------------ icons

const PATHS = {
  setup: '<path d="M3 4.5 4.5 6 7 3.5M3 10.5 4.5 12 7 9.5M9.5 5H14M9.5 11H14"/>',
  limits: '<circle cx="8.5" cy="8.5" r="5.7"/><path d="M8.5 5.5v3l2 1.5"/>',
  results: '<path d="M3.5 13.5v-5M8.5 13.5v-10M13.5 13.5v-7"/>',
  settings: '<path d="M3 5h11M3 8.5h11M3 12h11"/>',
  advice:
    '<path d="M6.5 13.5h4M7.2 15.5h2.6M8.5 2.5a4.3 4.3 0 0 0-2.5 7.8c.4.3.6.7.6 1.2v.2h3.8v-.2c0-.5.2-.9.6-1.2a4.3 4.3 0 0 0-2.5-7.8Z"/>',
  drift: '<path d="M2 9h3l2-5 3 9 2-4h3"/>',
  data: '<ellipse cx="8.5" cy="4.5" rx="5" ry="2"/><path d="M3.5 4.5v8c0 1.1 2.2 2 5 2s5-.9 5-2v-8M3.5 8.5c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
};

/** A small stroke icon for the nav. Decorative: the label beside it says what it is. */
export function icon(name) {
  return `<svg class="icon" viewBox="0 0 17 17" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] ?? ""}</svg>`;
}

// ------------------------------------------------------------- appearance

const APPEARANCES = ["dark", "light", "system"];

/** The saved appearance: dark unless someone chose otherwise. */
export function getAppearance() {
  try {
    const saved = localStorage.getItem("cg-appearance");
    return APPEARANCES.includes(saved) ? saved : "dark";
  } catch {
    return "dark";
  }
}

/** Save and apply it at once. theme.js applies it on the next load before first paint. */
export function setAppearance(value) {
  const next = APPEARANCES.includes(value) ? value : "dark";
  try {
    localStorage.setItem("cg-appearance", next);
  } catch {
    // Storage blocked: the choice still applies to this page.
  }
  document.documentElement.setAttribute("data-theme", next);
}
