# @costgrid/ui

CostGrid's design system. Ink on paper, with colour reserved for money moving.

## The rule

**Colour is never decorative.** Two colours exist and both are facts about
money: `--cg-over` for spend going the wrong way, `--cg-saved` for money kept.
Everything else is ink on paper. If something needs to stand out, use size,
weight or space.

This is what stops the product looking like every other AI tool, all of which
pick a brand accent and then paint buttons, links, icons and borders with it
until the accent means nothing.

Two supporting rules:

- **Mono is for things you would copy.** Code, model ids, tool names. Not nav,
  not buttons, not captions.
- **Prefer no box.** Separate with space first, a rule second, a border last.

`.design-sync/conventions.md` is the full brief, and is what Claude Design
reads.

## Build

```bash
npm install
npm run build     # dist/index.js, dist/index.css, dist/tokens.css, dist/*.d.ts
node check.mjs    # renders every component and asserts the colour rule
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

Change a token here, run the sync, and the site, the dashboard and Claude
Design all move together.

## Fonts

Newsreader (display), Instrument Sans (UI), JetBrains Mono (code). Every stack
has system fallbacks, because the gateway may run inside a network that cannot
reach a font CDN. The marketing site loads the webfonts; the dashboard is
designed to be fine without them.
