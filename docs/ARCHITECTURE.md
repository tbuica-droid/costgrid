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
  core/                 Pure domain. No I/O, no framework, no database.
  db/                   Schema, repositories, and read-side analytics.
    analytics.ts        Includes topology extraction and cycle detection.
    statement.ts        Calendar-month statements, and their CSV export.
  gateway/              The proxy: auth, enforcement, metering, passthrough.
    providers/          One adapter per upstream; the handler is generic.
    console.ts          Hosted control plane: accounts, credentials, billing.
    importers/          Historical backfill from each provider's admin API.
    ratelimit.ts        Per-tenant fixed-window cap.
  cli/                  Operator surface: keys, policies, reports, statements,
                        backups.
```

`core` has no dependencies at all, which is what makes the money and routing
logic testable without a database or a network.

## Decisions worth knowing about

### Hosted and self-hosted are one flag and two trust models

Self-hosted uses the operator's provider keys from env vars, shared by all
traffic — right for one organisation, catastrophic for many. Hosted stores each
tenant's own key, encrypted, and resolves it per request. `COSTGRID_HOSTED=true`
requires `COSTGRID_MASTER_KEY` and rejects `COSTGRID_ALLOW_ANONYMOUS`, both at
boot, because either mistake would silently bill the wrong party.

Operational details are in `HOSTING.md`, including what is deliberately not
built (no payment processor, one node, no email).

### Two secrets, two treatments

A tenant's provider key must be *decryptable* — the gateway presents it
upstream — so it is AES-256-GCM encrypted with a key derived from
`COSTGRID_MASTER_KEY` and held outside the database. Neither a database dump
nor the master key alone is enough. GCM authenticates, so a tampered row throws
rather than yielding a corrupted key that would be sent to a provider.

A password must *not* be decryptable, so it is scrypt-hashed with a per-user
salt and a cost parameter stored alongside, allowing the cost to be raised
later without invalidating existing passwords.

Session tokens are stored only as digests, like API keys. Login runs a real
verification against a dummy hash when the account does not exist, so response
time cannot enumerate addresses, and returns one message for both failure
causes.

### Imported history is never blended with metered calls

A provider's admin API returns daily aggregates assembled by someone else; a
metered call is a request we watched go past. Different fidelity, so they never
share a table and no view merges them into one number without saying so.
`imported_usage` is separate from `calls`, `/api/history` is separate from
`/api/overview`, and the dashboard labels the section "provider report".

Writing imports into `calls` would have been convenient and would have
fabricated call records, destroying the one dataset the product can stand
behind.

Where the provider reports a charged amount, that beats our list price — it
already includes whatever rate the customer negotiated. Comparing the two is
how an effective discount becomes observable rather than guessed at.

**The admin key is used and discarded.** A one-off backfill does not justify
holding a credential that can read an entire organisation's usage, and "we do
not keep it" is an easier sentence in a security review than any amount of
encryption. A test sweeps every column of the database to prove it.

### The console is not the dashboard

`/console` authenticates with a session cookie and manages accounts; `/api`
authenticates with an API key and serves the dashboard. Keeping them apart
means a browser session can never be used to spend tokens.

Because cookies are attached to cross-site form posts, `SameSite=Lax` alone is
not sufficient; every state-changing console route also checks that a declared
`Origin` matches the `Host` it arrived on.

A session cookie *can* identify a tenant for the read-only dashboard API — a
hosted customer should not have to paste an API key into their own console —
but never for the proxy. Browsers attach cookies cross-site, so accepting one
on `/v1/messages` would let any page on the internet spend a logged-in user's
tokens. Spending requires an API key, which a cross-site page cannot obtain.
`identify()` takes an explicit `allowSession` flag that only the read paths
pass, and there is a test asserting the proxy rejects a cookie.

Membership is checked on every console route rather than trusting a tenant id
from the URL — otherwise any signed-in user could administer any organisation
by guessing an id. A non-member gets 404, not 403, so the existence of an
organisation is not leaked.

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

### Providers are adapters, and the proxy handler is generic

`ProviderAdapter` owns everything upstream-specific: the route, auth scheme,
forwarded headers, where usage hides in a response, and how that provider's
stream reports totals. The handler in `server.ts` never branches on which
provider it is talking to, which is what keeps the third one cheap. A provider
with no configured credential is not registered at all — a caller gets a clean
404 rather than an upstream auth error they cannot act on.

### The two providers count tokens differently, and it matters

Anthropic's `input_tokens` **excludes** cached tokens; the buckets are
disjoint. OpenAI's `prompt_tokens` **includes** them; it is a total. Reusing
one parser for the other bills every cached token twice. Uncached input on
OpenAI is therefore `prompt_tokens - cached_tokens - cache_write_tokens`, and
a response whose cached count exceeds its total is rejected rather than
silently producing a negative.

Cache pricing differs structurally too. Anthropic derives writes from input
(1.25x for 5 minutes, 2x for an hour) and reads at 0.1x. OpenAI publishes a
per-model cached rate — gpt-4o reads at 0.5x, gpt-5 at 0.1x — and only its
newest generation charges for writes at all. Assuming a single multiplier
misprices most of the table.

OpenAI's newest models also have a **long-context tier**: roughly double above
272K context. That is selected from the call's own input size, so a large
request is not billed at half price.

### OpenAI streams carry no usage unless you ask

A streamed Chat Completion reports nothing unless the request set
`stream_options.include_usage`. Left alone, every streamed OpenAI call would
meter as free. The adapter adds it — but only when the caller did not specify
`stream_options` themselves, because someone who set it deliberately has made
a decision we should not override.

The cost is one extra trailing chunk with an empty `choices` array. That is
documented OpenAI behaviour and the official SDKs handle it, but a hand-rolled
parser assuming `choices[0]` could trip; `COSTGRID_OPENAI_INJECT_USAGE=false`
opts out.

When usage does not arrive, the call is recorded `priced: false` — visible as
an unpriced call — rather than as zero cost. That distinction is deliberate:
the failure mode of a metering product must be a visible gap, not a quiet
under-count.

### The price catalog carries its own provenance

Each provider records its own source URL and verification date in
`CATALOG_PROVENANCE`, and `scripts/verify-pricing.mjs` re-fetches both
published tables and diffs every rate. The catalog as a whole is only as fresh
as its stalest provider. Past `CATALOG_STALE_AFTER_DAYS` (45) the gateway warns
at boot, the CLI report prints a banner, and the dashboard shows one.

The verifier reads only each page's standard-pricing section. Both pages carry
batch, flex and fine-tuning tables with the same column shape, and parsing the
whole document lets a later table silently overwrite the rates actually billed
— which is how a verifier ends up confidently reporting the wrong discrepancy.
It caught exactly that during development.

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

### Auto-routing is the one rule that changes a request

Every other policy permits or refuses. A `route` rule rewrites the caller's
`model`, which means a bad rule degrades their product quietly and they will
blame their own code first. Four guards, enforced rather than advised:

- **`monitor` is a genuine dry run.** Nothing is rewritten; the call records
  what would have happened and what it would have saved. This is how a
  customer builds confidence before switching anything on, and it is the
  default the CLI picks.
- **Never across providers.** An Anthropic request body is not a valid OpenAI
  one, so rewriting `model` across providers would send a malformed request
  upstream and break the feature outright.
- **Never to an unpriceable model.** Otherwise the customer watches their
  traffic move and their reported spend fall to zero.
- **First match wins, and a blocked call is never routed.** Overlapping rules
  cannot chain a request through several models, and a refused call is not
  going anywhere to be rerouted.

### A run is a first-class thing, and an undeclared one is not

Metering a call answers "what did this cost". It cannot answer "what has this
*run* cost", which is the only question a runaway loop poses while there is
still time to act on it. `run_id` is therefore on every row, and three rules —
`run-budget`, `run-steps`, `run-depth` — read it before the next call is
forwarded.

Three decisions worth keeping:

**Every call has a run id.** A call with no `x-costgrid-run` header becomes its
own run, and historical rows were backfilled to their own id. Nulls here would
have forced a null branch into every query that groups by run, forever.

**Run rules never fire on an undeclared run.** Every synthetic run has exactly
one call, so a run budget on that traffic is unfireable and a step cap is
meaningless — the rule would be permanently inert while appearing enabled. The
alternative, stitching calls into runs by heuristic, means refusing a
customer's traffic on a guess. So the header is the contract, its absence is
recorded, and `costgrid runs` reports the coverage rather than leaving someone
to infer it from a feed that never fills.

**Depth is stored, not walked.** A run's depth is set once at insert from its
parent's, which is one indexed lookup. Recomputing it by recursing the parent
chain would put a recursive CTE between the caller and their provider. A parent
CostGrid never metered reads as depth 0: understating is recoverable, and a
fabricated depth would refuse traffic that breached nothing.

Run budgets share the windowed budget's eventual consistency — committed rows
only — so a run fanning out in parallel can overshoot by about one round trip.
Sequential runs, which is most agent loops, are exact.

### The topology is extracted, never configured

Which agents call which models, which tools they can reach, who delegates to
whom — all read off the wire. The alternative, a customer-maintained manifest,
is stale the day after it is written, and the gap between the diagram and the
deployment is the entire reason this view exists.

Tool **names** are stored; arguments never are. A name is structural, like a
table name, and it is all a reachability rule needs. Arguments are a refund
amount, a customer id, a SQL fragment — content, which is forwarded and not
kept. Names are length- and count-capped so a malformed or hostile response
cannot push unbounded text into the database through this path, and
`COSTGRID_EXTRACT_TOOLS=false` removes the path altogether.

Two tables, because the two facts have different shapes. An *invocation* is
sparse — most responses call nothing — and is kept per call so a run can be
audited step by step. A *grant* repeats on every request declaring the same
toolset, so it is aggregated: the thousandth identical declaration is not a
thousandth fact. Grants are also unwindowed, because a capability does not
lapse for going unused this week; that is precisely the tool a reachability
rule must still account for.

Cycle detection walks iteratively rather than recursively. The depth of a
delegation chain is decided by customer data, and a deep or adversarial one
must not overflow the stack of the process metering everyone's traffic.

### Negotiated rates are applied at record time, not at read time

An enterprise buys off list, so reporting list to them means every figure
disagrees with their invoice. `cost_total` is therefore what the call actually
cost that customer, and `cost_list` preserves the catalog price beside it.

Putting the effective figure in the *existing* column was the point. Every
budget, statement and analytic already reads it, so none of them can be left
behind reporting list prices — and a feature that reconciles in some places but
not others is worse than not having it. The alternative, multiplying at read
time, meant threading a rate through fifteen aggregate queries and trusting
that none was missed.

Rates are exact rationals. A manual discount of 18% is 8200/10000; a derived
one is the two observed totals themselves, so the override carries its own
evidence. Every multiplication goes through `mulDiv`, which rounds half away
from zero, so a discounted bill cannot drift the way a float multiplier would.
Percentages appear only in display, rounded at source — `1 - 8200/10000` is
18.000000000000004 in floating point, and a statement saying that is not one
anyone trusts.

Every bucket is scaled and the total re-summed from the scaled buckets, so the
parts still add to the whole. Scaling only the total would leave a breakdown
that disagrees with itself.

A derived ratio outside 5%–150% of list is refused. A mis-parsed invoice or a
mismatched window would otherwise corrupt every figure; refusing is
recoverable, silently mis-pricing a year of history is not.

### A budget can degrade instead of refusing

A hard cap protects the bill by breaking the customer's product, which is why
most teams never switch one on. A budget rule with a `fallbackModel` downgrades
over-budget traffic to a cheaper model instead of returning 403, reusing the
same substitution guards as routing.

When no downgrade is possible — most often because the traffic is *already* on
the fallback model — the rule's own action applies again, so a `block` cap is
still a cap. `warn` never refuses under any circumstance, and the trade is that
spend keeps accruing at the cheaper rate. Both rows are documented rather than
discovered in production. A budget fallback outranks a standing route rule (it
is the emergency measure); a separate block rule outranks both, because a
refused call is not going anywhere to be downgraded.

### Realised savings are separated from projected ones

`realisedSaving` covers calls actually rerouted; `potentialSaving` covers
dry-run matches. They are two figures, two cards, never summed. A customer in
dry-run mode has saved nothing yet, and presenting a projection as a realised
result would undermine every other number on the page.

Both are **estimates**, and every surface says so. The counterfactual prices
the observed tokens at the model originally requested — but token counts are
not invariant across models (Anthropic documents ~30% more on 4.7 and later,
and smaller models are often more verbose). Short of running each prompt
twice, that assumption is the closest honest answer.

The figure is signed. A route that costs more shows as a loss rather than
being clamped to zero: a savings number that can only go up is a marketing
number.

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

### A statement is a calendar month, not a trailing window

Every other view in CostGrid is "the last N days". The statement is the one
place that is not, because it exists to be reconciled against a provider
invoice — and invoices are issued per calendar month, in UTC. "The last 30
days" is never that number, and a finance team that discovers the difference
after filing has lost trust in every figure on the page.

Two consequences fall out of that. A month still running is labelled as
month-to-date and carries a projection derived from the run rate, kept as its
own field so it cannot be mistaken for a measurement. And a *daily* budget is
judged against the worst single day of the month rather than the month total,
because a $50/day cap and $1,200 of monthly spend say nothing about each other.

CSV is the export format because finance works in spreadsheets. Costs carry six
decimals rather than two: rounding a $0.004 agent to `0.00` would break the
invariant that the line items sum to the total, which the smoke test checks.

### Trailing windows end at `now + 1`

`TimeRange` is half-open, `[from, to)`. Every caller used to build
`to = Date.now()` by hand, which silently excluded any call recorded in that
same millisecond — the newest calls flickered in and out of the dashboard
depending on how the millisecond boundary fell. `trailingWindow()` is now the
single way to build one, and a regression test pins the boundary case.

## Testing

368 unit and integration tests, plus `scripts/e2e-smoke.mjs`, which boots a stub
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

- Bedrock and Google Cloud are not proxied. Both are partner-operated with
  separate pricing and their own auth (SigV4, GCP ADC), so each needs an
  adapter and its own catalog.
- OpenAI's Responses API (`/v1/responses`) is parsed but not routed; only
  `/v1/chat/completions` is exposed.
- The GitHub Pages site is static. `index.html` is the product page,
  `thesis.html` and `dashboard.html` the original research write-up and its
  seeded dashboard, and `demo/` runs the
  *real* dashboard bundle against captured API snapshots — a transport swap in
  `demo/demo-data.js` and nothing else, so the demo cannot drift from the
  product by reimplementing any of its numbers. Refreshing it means re-capturing
  the snapshots from a seeded gateway by hand.
- No payment processor. Plan changes record intent; an operator invoices.
- SQLite means a single node: no horizontal scale, no HA. The schema is
  Postgres-portable and the repository layer is the only code writing SQL, but
  the swap has not been made.
- Rate limiting is in-process, so the effective limit is `plan x instances`.
- No email: no verification, password reset, or invitations.
- `verify-pricing` is not yet wired to a scheduled CI job; it has to be run
  by hand today.
- Batch API calls are priced correctly but not yet *detected* — the gateway
  proxies `/v1/messages`, and batches go through a different endpoint.
