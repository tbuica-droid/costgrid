# CostGrid UI: how to build with this

CostGrid measures and controls what a company's software spends on AI APIs. The
reader is a founder or finance owner, not an engineer. Build pages from these
components; do not hand-roll something that already exists here.

## The rule that shapes everything

**Colour is never decorative.** There are exactly two colours in this system and
both are facts about money:

- `--cg-over` (rust) means spend going the wrong way: over budget, blocked,
  failed, rising.
- `--cg-saved` (green) means money kept.

Everything else is ink on paper. Do not colour a button, a link, an icon, a
border or a heading to make it look livelier. If something needs to stand out,
use size, weight or space. A page where the only colour is a red number is a
page where that red number gets read.

## Setup

- Components are self-styling. Every root carries `cg-root`, which sets the
  font, colour and tabular figures. There is no provider to wrap.
- Put `className="cg-root"` on your own layout containers so they inherit the
  same settings.
- Load the stylesheet once: `import "@costgrid/ui/styles.css";`

## Style your own layout with tokens, never new classes

- **Ink and paper:** `--cg-ink` `--cg-ink-soft` `--cg-ink-faint` `--cg-paper`
  `--cg-surface` `--cg-surface-sunk`
- **Rules, three weights with meanings:** `--cg-rule-hair` separates rows,
  `--cg-rule` closes a group, `--cg-rule-total` sits under a sum
- **Signals:** `--cg-over` `--cg-over-wash` `--cg-saved` `--cg-saved-wash`
- **Type:** `--cg-font-display` (serif, for headings and large figures)
  `--cg-font-sans` (everything you read) `--cg-font-mono` (only code and ids)
- **Sizes:** `--cg-text-xs` through `--cg-text-4xl`
- **Weights:** `--cg-weight-regular|medium|bold`
- **Space, 4px base:** `--cg-space-1` through `--cg-space-9`
- **Radius:** `--cg-radius-sm` `--cg-radius-md`. Nearly square on purpose.

## Type discipline

Three faces, and the split is not negotiable because breaking it is what made
the old site look machine-made:

| Face | Used for | Roughly |
|---|---|---|
| Serif (`--cg-font-display`) | Headings, and large figures in `Stat` | 10% |
| Sans (`--cg-font-sans`) | Everything anyone reads | 75% |
| Mono (`--cg-font-mono`) | Code, model ids, tool names, badges | 15% |

**Mono is not a decoration.** Do not set nav links, buttons, captions, labels or
body text in it. If a reader would not copy and paste it, it is not mono.

## Boxes

Prefer no border. `Panel` defaults to `plain` for that reason. A hairline box
around every group makes a page read as a uniform grid where nothing is more
important than anything else. Separate things with space first, a rule second,
and a box only when two surfaces genuinely need to be distinct.

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
