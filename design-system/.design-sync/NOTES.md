# Design-sync notes — @costgrid/ui

## Repo quirks

- **Webfonts are shipped with the dashboard, not by this package.** `Manrope` and
  `JetBrains Mono` are referenced in `src/tokens.css`; the
  `@font-face` rules and the woff2 files live in `packages/gateway/web/` (and its copy in
  `demo/`), served by the gateway itself because it may run inside a customer network
  that cannot reach a font CDN. This package carries no font files, so previews render in
  system-ui / Menlo and the `[FONT_MISSING]` warning is expected. Do not chase it.

- **`--node-modules ./node_modules`**: the repo does not self-install (`@costgrid/ui` is
  not in its own `node_modules`), so always use `--entry ./dist/index.js` and point
  `--node-modules` at the project root `node_modules`.

- **`--entry ./dist/index.js`**: the compiled ESM entry; confirmed by
  `package.json exports["."].import`. `dist/` is built via `npm run build`.

- **Playwright in `.ds-sync/`**: playwright was installed inside `.ds-sync/` (not the
  repo's own `node_modules`) so the validate script can import it. On a fresh clone, run:
  `cd .ds-sync && npm i playwright && npx playwright install chromium`

- **Known render warns**: none — 11/11 previews passed with 0 bad, 0 thin, 0
  variantsIdentical on the first pass.

## Re-sync risks

- **Previews tied to real data**: several previews use hardcoded numbers matching
  the current product copy (e.g. `$0.22` per call, `2,056` calls, budget figures).
  If the product story changes, previews will look dated but not break.
- **System font fallbacks**: renders look correct but subtly different from what users see
  if they have the brand fonts installed locally. Not a sync bug — intentional.
- **`cfg.overrides` cardMode entries** (`SectionHeader`, `DataTable`, `Callout`, `Meter`
  set to `cardMode: "column"`) — review on re-sync if any of these components gains
  variants that should be shown side-by-side instead.
- **No sibling packages**: currently no sibling icon package or tokens package. If one
  is added in future, add it to `cfg.extraEntries`.
