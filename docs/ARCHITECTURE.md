# Architecture

## What changed, and why

Before this, CostGrid was a single `index.html` with a seeded random-number
generator producing 90 days of fictional spend for 14 fictional agents, plus a
spreadsheet. It demonstrated a thesis. It could not meter a single real token.

The product is a **gateway**. Clients point their SDK's base URL at CostGrid;
it forwards each call to the provider, reads the exact token counts back out of
the response, prices them, and — before forwarding — decides whether the call
is allowed at all.

The alternative designs were considered and rejected:

- **Read-only billing ingest** never sits in the request path, which makes it
  an easy security review, but it can only ever report. Nothing on the
  marketing site's promise of "monitor / warn / block, per agent" is
  deliverable without being in the path.
- **SDK middleware** gets exact usage and can enforce, but requires a code
  change in every service and only covers languages we ship a library for.

Being in the request path is a real cost: CostGrid becomes a latency and
availability dependency. That is the price of enforcement, and it is why the
proxy path is deliberately thin — parse nothing that does not need parsing,
stream bytes through untouched, and never let a metering failure break a
caller's response.

## Package layout

```
packages/
  core/      Pure domain. No I/O, no framework, no database.
  db/        Schema, repositories, and read-side analytics.
  gateway/   The proxy: auth, enforcement, metering, passthrough.
  cli/       Operator surface: keys, policies, reports.
```

`core` has no dependencies at all, which is what makes the money and routing
logic testable without a database or a network.

## Decisions worth knowing about

### Money is integer nanodollars, carried as `bigint`

Token prices reach six decimal places per token. Floats cannot represent those
exactly, and a FinOps product that drifts by a cent has no credibility. All
money is an exact integer count of nanodollars (1 USD = 1e9). `bigint` rather
than `number` because 2^53 nanodollars caps out at about $9M — reachable by a
real client's annual aggregate. Conversion to float happens only for display.

### Five token buckets, not two

Input, output, 5-minute cache write, 1-hour cache write, and cache read all
bill at different multiples of the input rate (1x, output rate, 1.25x, 2x, and
0.1x respectively). Collapsing them into "tokens in, tokens out" is the single
most common way a cost estimate goes wrong, and it goes wrong by an order of
magnitude on cache-heavy workloads.

### The price catalog carries its own provenance

`CATALOG_SOURCE` and `CATALOG_VERIFIED_AT` sit next to the prices, and
`scripts/verify-pricing.mjs` re-fetches the published table and diffs every
rate. Past `CATALOG_STALE_AFTER_DAYS` (45) the gateway warns at boot, the CLI
report prints a banner, and the dashboard shows one.

A hand-maintained price table is a claim that decays silently — nothing breaks
when a rate changes, the bills are just wrong — so the decay has to be visible.
The verification script exits 2 when it cannot reach or parse the page, and
that must not be treated as a pass: unreachable means unverified, not correct.

### Three modifiers change the price without changing the model

Fast mode bills Opus 5 / 4.8 at $10/$50 instead of $5/$25. `inference_geo: "us"`
adds 10% to every category. The Batch API halves everything. Missing any of
them misstates a bill by 2x, 10%, or 2x respectively.

`speed` and `inference_geo` come back in the response `usage` object, so both
the buffered and streaming paths read what the provider actually charged for
rather than inferring it from the request. They are stored per call, which is
what makes a row's cost reproducible: two calls with identical token counts on
the same model legitimately cost different amounts.

Cache rates are multiples of the *effective* input rate, so they inherit
fast-mode pricing. Modifiers stack in published order: fast mode replaces the
base rates, then data residency, then batch.

### Rate arithmetic rounds, it does not truncate

`bigint` division truncates toward zero. Applied to a 1.1x or 0.5x modifier
that lands off a nanodollar boundary, that under-bills — by a hair, on every
call, always in the customer's favour and always wrong. `mulDiv` rounds half
away from zero so the error is unbiased.

### An unknown model is unpriced, never free

`findModelPrice` returns `undefined` for a model not in the catalog. The call
is still recorded with its true token counts, but flagged `priced = 0`, and
every report surfaces the count of unpriced calls and states that the total is
understated. A model released after our last catalog refresh must not silently
appear as zero-cost traffic.

### Bill the model that ran, not the one requested

A server-side fallback after a refusal can serve a different model than the one
asked for. Both the buffered and streaming paths take the model from the
provider's response, not from the request body.

### Budgets are scoped, and the scope is respected

An agent-scoped `$10/day` cap compares against *that agent's* spend. Passing one
flat spend snapshot to every policy would make narrow budgets fire on unrelated
traffic. `evaluatePolicies` takes a resolver and queries per scope, lazily —
only budget rules touch the database.

### Budget enforcement is eventually consistent, on purpose

Spend is read from committed rows, so calls still in flight are not counted. A
burst of concurrent requests can overshoot a cap by roughly one round-trip's
worth of spend. The alternative — serialising every call behind a write lock —
would put CostGrid on the critical path for latency as well as cost. The
overshoot is bounded and documented; the lock would be neither.

### Streaming: client first, metering second

The gateway writes each chunk to the caller before feeding a copy to the usage
collector, and respects backpressure rather than buffering the response. The
collector never throws: losing a usage record is recoverable, corrupting a
caller's response is not. A stream that ends without a `message_start` is
recorded as `error`, because its partial usage should not be trusted.

`message_delta.usage.output_tokens` is **cumulative**, not incremental, so
usage fields are overlaid rather than summed. Getting this backwards
over-counts output on every streamed call.

### Backups need the backup API, not `cp`

In WAL mode recent commits live in the `-wal` sidecar until a checkpoint, so
copying the main file alone silently loses the most recent calls — exactly the
ones a customer is most likely to be asking about. `costgrid backup <path>`
uses SQLite's backup API, which checkpoints as it goes. This was found the
hard way: a `cp` of a live database during testing came back missing a call.

### SQLite now, Postgres later

No Docker on the target machine, and a self-hosted single-tenant deploy should
not require a database server. Every construct in the schema is portable:
integer timestamps, TEXT ids, money as INTEGER, no SQLite-only types. The
repository layer is the only code that writes SQL.

### Multi-tenant from the first migration

The first deployment is single-tenant. The `tenant_id` column exists anyway,
because retrofitting one onto a metering table with production rows is the kind
of migration that causes an outage.

### API keys are stored as hashes

Only a SHA-256 digest is persisted; the plaintext is shown once at creation. A
database leak does not hand an attacker working credentials.

### The dashboard has no sample data, on purpose

`packages/gateway/web` renders only what the API returns. There is no seeded
fallback: an empty database produces an empty state that tells you how to send
a call, not a plausible-looking chart. The whole pitch is that the numbers are
measured, and a dashboard that invents them when the database is empty is how a
demo gets mistaken for a deployment.

It also ships no CDN dependencies. Charts are inline SVG rather than Chart.js,
and there is no webfont fetch or CSS framework, so the dashboard renders
correctly inside a customer VPC with no egress.

### Money crosses the wire as a string

API responses carry money as decimal strings (`"12.345678"`), never JSON
numbers. JSON's number type is a double; serialising nanodollars through one
would reintroduce exactly the drift the bigint representation exists to
prevent. A `…Usd` suffix means "display this, don't compute with it".

### Trailing windows end at `now + 1`

`TimeRange` is half-open, `[from, to)`. Every caller used to build
`to = Date.now()` by hand, which silently excluded any call recorded in that
same millisecond — the newest calls flickered in and out of the dashboard
depending on how the millisecond boundary fell. `trailingWindow()` is now the
single way to build one, and a regression test pins the boundary case.

## Testing

138 unit and integration tests, plus `scripts/e2e-smoke.mjs`, which boots a stub
provider, runs the real gateway process against it, drives real HTTP traffic
(buffered and streaming), and reads the database back through the real CLI. No
test reaches a real provider or needs an API key.

```bash
npm test                      # unit + integration
node scripts/e2e-smoke.mjs    # full stack against a stub provider
npm run verify-pricing        # catalog vs. the live published pricing table
```

Migrations are tested against a *populated* database built at the previous
version, not a fresh one — an upgrade that drops a row from a customer's
billing history is unrecoverable without a backup.

## Not built yet

- Only Anthropic is proxied. OpenAI, Bedrock and Vertex need their own usage
  adapters — the `Provider` type and the tier model already anticipate this.
- `index.html` at the repo root is untouched and remains the seeded marketing
  demo, served by GitHub Pages. It is not the product dashboard.
- No hosted control plane, billing, or signup. Deployment today is
  self-hosted.
- `verify-pricing` is not yet wired to a scheduled CI job; it has to be run
  by hand today.
- Batch API calls are priced correctly but not yet *detected* — the gateway
  proxies `/v1/messages`, and batches go through a different endpoint.
