# CostGrid UI: how to build with this

CostGrid measures and controls what a company's software spends on AI APIs. The
reader is a business owner or finance owner, not an engineer. Build pages from
these components; do not hand-roll something that already exists here.

## The look: Midnight

Dark is the brand and the default. Light is opt-in (`data-theme="light"` on
`<html>`, or `data-theme="system"`).

- **Readable first.** Manrope for everything anyone reads. App body 14.5px,
  site body 16 to 17px, never below 12.5px.
- **Lavender is the one accent** (`--cg-accent`): primary buttons, the active
  nav icon, the headline figure, the focus ring. Never a fill for a large area.
- **Colour for state only, always with a word:** `--cg-good` (on track),
  `--cg-warn` (needs a look), `--cg-bad` (failing), each with a `-bg`.
- **Depth from 1px lines** and one soft shadow on raised windows. No
  gradients, glow, glass, emoji or left-border cards.
- **Shapes:** buttons and status pills fully rounded; cards 12px; inputs 10px;
  windows 14px.

## Setup

- Components are self-styling. Every root carries `cg-root`, which sets the
  font, colour and tabular figures. There is no provider to wrap.
- Put `className="cg-root"` on your own layout containers so they inherit the
  same settings.
- Load the stylesheet once: `import "@costgrid/ui/styles.css";`

## Style your own layout with tokens, never new classes

- **Surfaces:** `--cg-bg` `--cg-sidebar` `--cg-surface` (panels, tables)
  `--cg-surface-2` (KPI tiles, hover) `--cg-nav-active`
- **Lines:** `--cg-line` (group borders) `--cg-line-soft` (row dividers)
  `--cg-control` (input and outline-button edges)
- **Ink:** `--cg-ink` `--cg-ink-2` (secondary text) `--cg-ink-3` (captions)
- **Accent:** `--cg-accent` `--cg-on-accent` `--cg-accent-wash`
  `--cg-accent-line` `--cg-chart` (chart marks)
- **State:** `--cg-good` `--cg-warn` `--cg-bad` and their `-bg`
- **Type:** `--cg-font-display` and `--cg-font-sans` (both Manrope)
  `--cg-font-mono` (only keys and ids)
- **Sizes:** `--cg-text-xs` (13) `--cg-text-sm` (14) `--cg-text-body` (14.5)
  through `--cg-text-4xl`
- **Weights:** `--cg-weight-regular|medium|semibold|bold`
- **Space, 4px base:** `--cg-space-1` through `--cg-space-9`
- **Radius:** `--cg-radius-sm` `--cg-radius-field` `--cg-radius-md`
  `--cg-radius-window` `--cg-radius-pill`

## Type scale (Manrope)

| Use | Size / line height | Weight |
|---|---|---|
| Site hero | 66 / 1.06, -0.03em | 700 |
| Site section | 40 / 1.1, -0.02em | 700 |
| App page title | 24 / 1.2, -0.02em | 700 |
| Figure | 30, -0.02em | 700 |
| Body | 15 to 16 / 1.55 | 400 |
| Small | 13 / 1.45 | 400 |
| Label | 13 | 500, sentence case |

Uppercase only for the site overline: 13px, 600, 0.12em tracking, accent.

**Mono is not a decoration.** Do not set nav links, buttons, captions, labels or
body text in it. If a reader would not copy and paste it, it is not mono.

## Numbers

Every figure is already tabular and lining. When you write a number outside a
component, add `className="cg-num"`. Right-align numeric table columns. Never
let a column of costs jitter as its digits change.

## Writing

- Plain English for a non-technical reader. No jargon they would have to look up.
- **No em dashes.** Use a full stop, a comma or a colon.
- Say what a figure rests on. If it is an estimate, the caption says so; that is
  what `Callout` is for.

## Components

`Badge` `Button` `Callout` `CodeBlock` `DataTable` `Delta` `Field` `Meter`
`Panel` `SectionHeader` `Stat`
