/**
 * Shared bits of the console's markup.
 *
 * Their own file so that `console.js` and `console-security.js` can both use
 * them without importing each other. A cycle between those two would work
 * today and break the first time one of them moved a call to module scope.
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
  return `<label style="display:block;margin-bottom:14px">
    <span class="rail" style="display:block;margin-bottom:6px">${escapeHtml(label)}</span>
    <input name="${name}" type="${type}" ${extra}
      style="width:100%;max-width:420px;padding:9px 11px;border:1px solid var(--rule);
             background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px" />
  </label>`;
}

export function button(text, attrs = "") {
  return `<button ${attrs}
    style="font-family:var(--mono);font-size:12px;letter-spacing:0.04em;padding:9px 16px;
           border:1px solid var(--ink);background:var(--ink);color:var(--bg);cursor:pointer">
    ${escapeHtml(text)}</button>`;
}
