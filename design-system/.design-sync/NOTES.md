# Design-sync notes — @costgrid/ui

## Repo quirks

- **No webfonts shipped by design.** `Instrument Sans`, `JetBrains Mono`, and `Newsreader`
  are referenced in `src/tokens.css` but no `@font-face` exists anywhere in the repo.
  The comment in `demo/styles.css` explains: "No CSS framework and no webfont CDN: the
  gateway may run inside a customer network that cannot reach either. Every font stack has
  system fallbacks for exactly this." Previews render in Georgia / system-ui / Menlo and
  look correct. The `[FONT_MISSING]` warning is expected and accepted. Do not chase it.

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
