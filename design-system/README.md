# @costgrid/ui

CostGrid's design system, "Midnight". Dark by default, one champagne accent,
Manrope for everything you read.

## The rules

**Readable first.** One face, Manrope (400, 500, 600, 700), for all UI and
headings. App body text is 14.5px, captions never below 12.5px, and every text
colour clears 4.5:1 against its background in both themes. Figures are tabular
everywhere numbers line up.

**Champagne is the one accent.** `--cg-accent` marks primary buttons, the
active nav icon, the headline figure and the focus ring. It is never a fill for
a large area, and nothing else competes with it.

**Colour for state, always with a word.** `--cg-good`, `--cg-warn` and
`--cg-bad` (each with a `-bg`) mean on track, needs a look and failing. A
status pill always says which in words; colour alone never carries the
meaning. The older names `--cg-saved*` and `--cg-over*` map to good and bad.

Supporting rules:

- **Mono is for things you would copy.** Keys and ids, in JetBrains Mono. Not
  nav, not buttons, not captions.
- **Depth from lines.** 1px borders and one soft shadow on raised windows. No
  gradients, glow, glass or left-border cards.
- **Shapes.** Buttons and status pills are fully rounded; cards and panels
  12px; inputs 10px; windows 14px.

`.design-sync/conventions.md` is the full brief, and is what Claude Design
reads.

## Themes

Dark values sit on `:root`. Light is opt-in: `data-theme="light"` on `<html>`,
or `data-theme="system"` to follow the operating system. The dashboard stores
the choice in `localStorage` (`cg-appearance`) and applies it before first
paint.

## Build

```bash
npm install
npm run build     # dist/index.js, dist/index.css, dist/tokens.css, dist/*.d.ts
node check.mjs    # renders every component and asserts the state colours
```

## Where the tokens are used

`src/tokens.css` is the single source. It reaches two places:

1. **Claude Design**, via the compiled `dist/index.css` that `/design-sync`
   uploads.
2. **The product dashboard**, which is vanilla CSS served inside customer
   networks and cannot import a package at runtime. `npm run sync-design-tokens`
   from the repo root inlines the token block into
   `packages/gateway/web/styles.css` and `demo/styles.css`.
   `npm run check-design-tokens` fails if they have drifted.

Change a token here, run the sync, and the dashboard and Claude Design move
together.

## Fonts

Manrope (everything) and JetBrains Mono (keys and ids). The dashboard ships
them with itself (`packages/gateway/web/fonts/`), because the gateway may run
inside a network that cannot reach a font CDN. Every stack has system
fallbacks for the moment before they load.
