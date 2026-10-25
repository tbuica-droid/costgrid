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

## Version 2: cost per successful outcome, added to the app

Recorded in [ADR-0001](adr/0001-v2-view-and-control-additive.md). Version 2 is
built on top of everything below, not instead of it: the desktop app keeps
running the embedded gateway, and the proxy stays as the advanced, per-run
control path.

- **The LCSO engine is pure.** `packages/core/src/lcso.ts` (types in
  `lcso-types.ts`) takes tasks, their runs and their outcome states and returns
  LCSO-1/2/3, Failure Cost Share, cost spread (p50/p90/p99, spread ratio, tail
  share), success, clawback and autonomy rates, and HER. It does no I/O, so
  step 5 (results screen) and step 9 (statement) call it with whatever the
  repositories hold. The method's §14 worked example is a golden test
  (`packages/core/test/lcso.test.ts`), and seven invariants run over seeded
  random inputs (`lcso-properties.test.ts`).
- **Counted per task, not per run.** A retry never improves the success rate.
  UNKNOWN outcomes count as failures. A success inside its maturation window is
  pending: excluded from both sides, its cost carried forward.
- **Quotients are exact.** `ratio.ts` carries numerator and denominator as the
  bigint sums that produced them and rounds once, at display, half away from
  zero. `toUsdString` truncates, so per-outcome figures go through
  `formatUsdPerOutcome` instead.
- **A missing figure is never zero.** Every metric is `Reported<T>`: a value,
  or the reason it is withheld (no successes, aggregate mode, no human
  baseline…). Owners who only connect provider usage reports get the aggregate
  mode, where failure share and spread are "not reported".
- **Percentiles are nearest-rank in integers** (`stats.ts`), shared with the
  insights reports, so a reported p90 is the cost of a real task.

### Owner setup: sign in, connect, say what each workflow is for

Step 2 gets a non-technical owner from install to their real costs without
code. The old proxy steps are still there, folded under "Advanced".

- **Two ways in, no admin role needed for the second.** A read-only admin key
  (imports 90 days, then syncs every 6 hours) or the provider's usage export
  dropped onto the window. "Ask my developer" writes a message the owner can
  copy; it never contains a key or a link to their computer.
- **Usage is broken down by source.** `imported_usage` rows carry a source:
  a Claude API key or workspace, an OpenAI project or API key, or `account`
  when the report has no breakdown. `usage_sources` lists them; step 3 puts
  each one on an agent.
- **An import replaces its window.** `ImportsRepository.putRows` deletes the
  provider's rows for the days it covers and inserts the new ones in one
  transaction, so an old account-level total and a new per-source breakdown
  of the same day can never be added together.
- **CSV columns are matched by name, never position.** Both providers add
  columns over time. `importers/csv.ts` reads Claude's
  `claude_api_tokens_*.csv` and OpenAI's `completions_usage_*.csv`, folds
  hourly and per-minute buckets to days, recognises cost exports and asks for
  the usage export instead, and reports problems in plain words. A Claude
  export names keys rather than identifying them, so its source is
  `<workspace> / <key name>`; the admin API uses ids (matched below).
- **The gateway never loads native code.** The secure store is an interface
  (`packages/gateway/src/secret-store.ts`). The desktop app supplies a
  Keychain-backed one (`packages/desktop/src/secret-store.ts`, using
  `@napi-rs/keyring`), probed at start; without it the key is used once, as on
  a server.

### Agents: which key, workspace or project is which job

Step 3 of setup. An **agent** is one job the owner's AI does ("Support bot").
The owner names it, picks its purpose preset (`packages/core/src/presets.ts`:
support, sales leads, content, data entry, other, each with what counts as a
finished job), and says which sources it uses.

- **One table for both kinds of agent.** `agents` holds the agents the proxy
  registers on first sight and the agents an owner names (`origin`). An
  owner's agent id is a slug of its name and doubles as the
  `x-costgrid-agent` value, so proxied traffic sent under it lands on the same
  agent. Seen-times are NULL until it sends any, and the Limits screen only
  lists agents that have.
- **A source belongs to one agent or none.** `usage_sources.agent_id`, checked
  by `AgentsRepository` (`packages/db/src/agents.ts`) because SQLite cannot add
  a two-column foreign key to an existing table. A key used by several agents
  is marked `shared` and is never put on any of them: neither provider can
  split one key's usage by request, so CostGrid does not divide it by
  guesswork. The console explains how to give each agent its own key instead.
- **The same Claude key seen two ways is matched by name.** A usage file's
  `Support / support-bot` and the admin API's `apikey_…` labelled
  `support-bot` in workspace `Support` are paired by
  `packages/core/src/source-match.ts` only when each is the other's only
  candidate. An undecided twin then takes its partner's agent
  (`assigned_by = 'match'`, audited as `source.matched` by the system). An
  owner's decision, including "not the same key", is never overridden. Keys
  outside a workspace are not matched until a real export confirms how the
  file names the default workspace.
- **Imported and metered cost stay apart per agent.** An agent card shows the
  provider-report cost of its sources (with the list-price estimate share
  labelled) and, separately, the cost of calls CostGrid measured under its id.
  Never one number made of both.
- Migration 15 turned every source named in step 2 into an agent of its own,
  so nothing typed there was lost.

### Outcome detection: inferred, labelled, and never mixed with reports

Step 4. Whether a job got done is decided per agent from proxied traffic only;
provider usage reports have no runs.

- **Pure rules in core.** `run-status.ts` reads each provider's stop reason,
  `escalation.ts` matches hand-off tool names by word, and `outcome-detect.ts`
  groups runs into jobs and decides each one: reported (tier B) wins, then a
  hand-off, a CostGrid limit, an error, cut-off or refusal; a job that ended
  normally is finished only if it can be recognised again, because otherwise a
  re-run could not have been seen. The LCSO engine then holds fresh successes
  as pending and reverses those asked again inside the maturation window.
- **Presets are versioned, never edited.** Version 2 adds each purpose's re-run
  window and describes what CostGrid can actually see. Agents keep the version
  they chose; a version 1 agent is offered the upgrade, not moved silently.
- **Job identity is metadata.** `calls.task_key` holds the developer's
  `x-costgrid-task`, or a 128-bit HMAC of the job's normalised first message
  (`task-fingerprint.ts`), keyed per organisation from an install key kept in
  the OS keychain (`fingerprint-key.ts`; derived from the master key where
  there is no keychain). The message lives in one local variable in
  `task-identity.ts` and is never logged or stored; a test searches every table
  and every byte of the database for it. Codes sit on `calls`, so retention
  purges them with the calls, and turning matching off deletes them.
- **Computed on read.** `run-outcomes.ts` summarises runs (sub-agents folded
  into their parent), attaches hand-offs and reports, and runs the detector and
  the engine for the period, so nothing derived is stored and a changed rule
  restates history consistently.

### The results screen: one sentence per agent, from fixed rules

Step 5. Each agent card on Results opens with a verdict sentence, the cost per
finished job and the figures behind it.

- **The verdict is a rule, not a guess.** `verdict.ts` picks one kind from an
  `LcsoResult`, first match wins: no data, spend with no finished job, too
  early, dearer than a person, half or more of the spend on failures, a bad
  job (p90) at 3× a typical one (p50), steady. Comparisons are exact
  (`compareRatio`), so a boundary case always lands the same way. The console
  writes the sentence (`console-verdict.js`) and marks it indicative.
- **The owner's estimates are kept apart.** `agent_person_cost` (minutes per
  job and a fully loaded hourly rate) becomes the engine's `humanBaseline`, so
  the comparison is HER: AI model cost per finished job over the person's.
  `agent_job_counts` holds monthly counts for agents seen only in provider
  reports; their newest counted month is priced with `computeLcsoAggregate`
  from that month's imported cost, so failure share and spread are "not
  reported" there. Both tables go with their agent and with the organisation.

### Key safety: warnings from what the key lists already say

Step 6. The sync that already lists keys for their names (`importers/names.ts`)
now also keeps what those lists say about each key in `provider_keys`: status,
when it was made, when it was last used (OpenAI only), whether a person or a
service account owns it (OpenAI), and whether it sits in Claude's Default
workspace. Metadata only, no new calls and no key material. The table is
replaced per provider on each sync whose lists were read in full, and cleared
when the admin key is forgotten, so it never goes stale silently.

`key-safety.ts` in core turns those facts, the agents' sources and the stored
admin keys into an ordered list of warnings: an admin key expired, failing or
expiring within 14 days; a shared key; spend in the last 30 days on no agent;
usage with no per-key breakdown; an active key idle for 90 days; a key in the
Default workspace; a person's key; a key over a year old. Where the provider
gives no last-use date (Claude), "idle" means no usage seen in the 90 days
CostGrid imports, and the screen says "at least". The Setup screen shows each
with what could go wrong and how to fix it at the provider; nothing is changed
from CostGrid.

### View and control: pausing keys, caps and measured stop time

Steps 7 and 8. `AccessTier` (`billing.ts`) is View or View and control, kept in
`tenant_tier` and set by the operator (`costgrid tier control`) until pricing is
decided; it is apart from the older price plans.

- **Pause is Claude only.** `key-status.ts` sets a key `inactive` or `active`
  through Anthropic's Admin API (never `archived`, which cannot be undone), and
  checks the status Anthropic reports back. OpenAI documents no key pause, so
  its sources are listed as "can't be paused" with guidance.
- **CostGrid pauses only what was working, and resumes only what it paused.**
  `key-control.ts` reads each key's status first (a workspace means its active
  keys at that moment) and records every request in `key_actions` before
  asking. Resume turns on the keys whose latest successful action is
  CostGrid's pause, on any tier and even after the agent is removed, so a key
  is never stranded off.
- **Caps act on the usage report.** The background sync runs hourly for
  organisations with a cap (every six hours otherwise), then `checkCaps`
  compares month-to-date provider-reported cost with each cap. A cap pauses
  once per month per cap setting; an owner's resume stands until the cap is
  changed, and a failed pause is retried. One alert says the cap was reached
  and what was done.
- **Stop time is measured, not promised.** Each cap pause stores the end of
  the newest usage day it saw; the screen shows how far behind the report was
  and how long Anthropic took to act.
- Control jobs for one organisation run one at a time in the process, so an
  owner's click and the hourly check cannot both pause the same keys.

### The statement carries cost per finished job

Step 9. `statement-jobs.ts` runs `RunOutcomes` for the statement's month and
turns each agent's LCSO result into a row: counts, spend, LCSO-1, failure
share, the person ratio, the verdict, and the basis (inferred, reported, mixed
or the owner's count). A closed month is judged as of now with runs read past
its end, so late re-runs and reversals count and month-end jobs have matured.
The section is optional on `buildStatement` (`runOutcomes`), and a failure in it
leaves the statement without the section rather than failing the statement.

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
    importers/          Usage from each provider's admin API or usage export.
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

**The admin key never touches the database.** On a server, it is used once
and discarded: a one-off backfill does not justify holding a credential that
can read an entire organisation's usage. The desktop app keeps it, because an
owner wants their numbers to stay current without pasting a key every week,
but only in the operating system's secure store (Keychain on a Mac, Credential
Manager on Windows), only after the first import has worked, and only with the
expiry the owner chose. The database holds the last four characters, the
expiry and the sync status. A test sweeps every column of the database to
prove the key itself is not there.

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

### Bedrock and Vertex are channels, not new models

Both serve the models the catalog already knows. They are separate providers
here because they bill separately, hold separate credentials, and must never be
routed across — a Bedrock model id is not valid on the Anthropic API — but
their ids normalise onto the same catalog entries rather than duplicating the
table three times.

What differs is packaging, and it drove two changes to the adapter contract.
`authHeaders` is async and receives the method, URL and exact body bytes,
because SigV4 signs all three and Vertex exchanges a key for a token.
`upstreamPath(model, streaming)` replaces a fixed path, because both channels
name the model in the URL and stream from a different endpoint than they buffer
from. The order in the proxy handler follows from that: route, then body, then
URL, then signature — anything that rewrites the body after signing invalidates
it.

SigV4 is implemented rather than imported: the gateway has three runtime
dependencies and the AWS SDK would be the largest by an order of magnitude, for
one signature. Bedrock's streams are binary event-stream frames rather than
SSE, so they need their own decoder; the prelude CRC is checked on every frame
so a real stream that disagrees with this implementation fails loudly instead of
metering zero.

**Neither has been verified against a live account.** The signature is checked
against Amazon's documented example and the CRC against its canonical vector,
which is as far as verification goes without credentials. `costgrid preflight
<provider>` hands the rest to whoever has an account: one real call, naming the
stage that failed. That command exists precisely because "it should work" is
not something a cost tool gets to say.

Channel *pricing* is the known approximation. Both publish their own per-region
rates, which this catalog does not carry, so traffic prices at the direct-API
list rate for the same model and `costgrid rates derive` against the AWS or GCP
bill makes it exact.

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

### A stop is a rule, not a flag

Stopping an agent, a team or everything writes a `stop` rule that blocks, and
resuming switches it off. That way a stop travels through everything a rule
already has: the enforcement feed, the rule register, the audit log, alerts and
the evidence pack. Resuming keeps the record, and stopping the same scope twice
is refused rather than stacked, so one resume is always enough.

### Alerts are once per event, and off the request path

A team over its monthly budget is over it on every call for the rest of the
month. Each alert therefore carries a dedupe key (the rule and its window, the
run, or the rule and the hour) and the database refuses a second alert with the
same key. Raising one is an insert; delivering it is a network call on its own
time, and nothing about an alert can change or delay the enforcement decision
it reports. The webhook address is a credential, so it is encrypted under the
master key and only ever shown back as a masked hint.

### Savings are measured before and after, not only estimated

The estimate prices the tokens a call used at the model the caller asked for,
which assumes a different model would have used the same number of tokens. The
price-reversal research (arXiv:2603.23971) shows that assumption fails often
enough to matter. So for every rule that has moved traffic, CostGrid also
compares the same scope's calls on the original model in the fortnight before
the rule went live with the calls it moved afterwards, per call and per whole
run, and says "not enough data" below thirty calls a side. It is labelled as a
before-and-after comparison, not a controlled experiment. `live_since` on the
policy row is the line it is drawn at, and it moves when a rule is switched back
on.

### Reasoning is recorded where reported, never estimated

OpenAI reports reasoning tokens per call; they are stored in
`reasoning_tokens` and costed at the output rate, which is exact. Anthropic does
not split thinking out of `output_tokens`, so for Claude traffic the column is
NULL and only what the request asked for (`reasoning_requested`) is kept. A
reasoning cap judges only requests that name an effort or a budget: refusing a
request that names neither would guess at the provider's default.

### Entered costs never mix with metered ones

Licences, platform and people's time are typed in by month and category, and
every surface that shows them shows metered spend and entered cost as two
figures beside their sum. A typed-in number must never be mistaken for a
measured one.

## Testing

717 unit and integration tests, plus `scripts/e2e-smoke.mjs`, which boots a stub
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

- Bedrock and Vertex are proxied but priced at the direct-API list rate and
  have not been run against a live account (see above).
- OpenAI's Responses API (`/v1/responses`) is parsed but not routed; only
  `/v1/chat/completions` is exposed.
- The website (Vercel, costgrid.dev) is static. `index.html` is the product page
  and `research.html` the sources and the LCSO method (the old thesis and
  research-dashboard pages redirect there). Both load only first-party files
  under a strict Content-Security-Policy in `vercel.json`, with Manrope
  self-hosted in `fonts/`. `demo/` runs the
  *real* dashboard bundle against captured API snapshots — a transport swap in
  `demo/demo-data.js` and nothing else, so the demo cannot drift from the
  product by reimplementing any of its numbers. Refreshing it means re-capturing
  the snapshots from a seeded gateway by hand.
- No payment processor. Plan changes record intent; an operator invoices.
- SQLite means a single node: no horizontal scale, no HA. The schema is
  Postgres-portable and the repository layer is the only code writing SQL, but
  the swap has not been made.
- Rate limiting is in-process, so the effective limit is `plan x instances`.
- The gateway sends no email: no verification, password reset or invitations.
  Alerts go to a webhook or a desktop notification. (Website sign-in uses an
  emailed link through Supabase, which is separate from the gateway.)
- `verify-pricing` runs before every app release (`npm run app:release` stops
  on a mismatch) but not on a schedule, so a price change between releases is
  caught at the next release or by running it by hand.
- Batch API calls are priced correctly but not yet *detected* — the gateway
  proxies `/v1/messages`, and batches go through a different endpoint.
