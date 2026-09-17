# Quickstart — metering your own LLM usage

> This is the **self-hosted** path: one organisation, your own provider keys in
> environment variables. To run CostGrid as a service other people sign up for,
> see [HOSTING.md](./HOSTING.md).

This is the shortest path from a clean checkout to a real spend report from
your own traffic. It costs whatever your own calls cost and nothing more:
CostGrid adds one local network hop and no charges of its own.

## 1. Install and build

```bash
npm install && npm run build
```

## 2. Add your key

**Never paste a key onto a command line.** It lands in your shell history, and
a missing space turns `cp .env.example .env<key>` into a file whose *name* is
your secret. Use the prompt below: it reads the key with echo off, so the key
never appears on screen, in history, or in a process argument list.

```bash
cp .env.example .env && printf 'Anthropic API key (input hidden): ' && read -rs KEY && echo && \
  sed -i '' "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${KEY}|" .env && unset KEY && \
  echo "Key written to .env"
```

Prefer an editor? `cp .env.example .env` then open `.env` and paste the key
after `ANTHROPIC_API_KEY=`. That is equally safe — the danger is only the
command line.

**OpenAI too?** Add `OPENAI_API_KEY=` on its own line the same way. Each
provider gets its own route, and a provider with no key serves none:

| Provider | Route on the gateway |
|---|---|
| Anthropic | `POST /v1/messages` |
| OpenAI | `POST /v1/chat/completions` |

Spend from both lands in one tenant view, and a budget policy applies across
them — a cap blown on OpenAI blocks the next Anthropic call.

The gateway holds this credential so the services calling through it never
need it. That indirection is the point: a compromised caller can be cut off in
CostGrid without rotating your provider key.

`.env` is gitignored, along with anything else starting `.env` except the
example — including a file accidentally *named* after a key.

## 3. Create the local tenant

```bash
npx tsx packages/cli/src/main.ts init
```

This prints an API key once. With `COSTGRID_ALLOW_ANONYMOUS=true` you do not
need it yet, but store it now — it is not recoverable.

## 4. Start the gateway

```bash
set -a && source .env && set +a && npm run gateway
```

It listens on `http://127.0.0.1:8787`.

## 5. Send traffic through it

Any Anthropic SDK works — point its base URL at the gateway and CostGrid
meters everything that flows through.

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "content-type: application/json" \
  -H "x-costgrid-agent: my-first-agent" \
  -H "x-costgrid-department: Engineering" \
  -d '{
    "model": "claude-opus-5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Say hello in five words."}]
  }'
```

In Python or TypeScript, set the base URL on the client:

```python
client = Anthropic(base_url="http://127.0.0.1:8787", api_key="unused")
```

```typescript
const client = new Anthropic({ baseURL: "http://127.0.0.1:8787", apiKey: "unused" });
```

OpenAI clients point at the same host:

```python
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused")
```

The SDK still needs an `api_key` argument, but the gateway ignores it and
substitutes its own — so a placeholder is correct here, not a shortcut.

### Attribution headers

| Header | Meaning | Default |
|---|---|---|
| `x-costgrid-agent` | The cost line this call belongs to | `unattributed` |
| `x-costgrid-department` | Budget owner grouping | `Unassigned` |
| `x-costgrid-key` | CostGrid API key (required unless anonymous) | — |

Unlabelled calls are metered, not dropped. They show up as `unattributed`,
which is a visible cost line rather than a silent gap.

## 6. Open the dashboard

With the gateway running, visit **<http://127.0.0.1:8787>**.

Six views: Overview (spend, cache hit ratio, per-model/agent/department
breakdowns), Statement (a calendar month, with CSV export), Agents (one row per
cost line), Routing (your measured substitution share against the modelled
optimum), Policies (rules and the enforcement feed), and Pricing (the catalog).

Everything on it is read from metered calls. There is no sample data — an
empty database shows you an empty state, not a plausible chart.

## 7. Read the report

Same numbers, in the terminal:

```bash
npx tsx packages/cli/src/main.ts report --days 7
```

You get total spend, run-rate, cache hit ratio, a per-model and per-agent
breakdown, your measured substitution share, and the routing headroom implied
by it.

## 8. Turn on enforcement

Start in `monitor` so you can see what a rule would do before it does it:

```bash
# Watch, don't block
npx tsx packages/cli/src/main.ts policy budget tenant 50.00 --window month --action monitor

# Warn one team at 80% of its budget
npx tsx packages/cli/src/main.ts policy budget dept:Engineering 200.00 --action warn

# Actually stop a runaway agent
npx tsx packages/cli/src/main.ts policy budget agent:chat-bot 5.00 --window day --action block

# Restrict the fleet to models you have approved
npx tsx packages/cli/src/main.ts policy allow claude-haiku-4-5 claude-sonnet-5 --action block

npx tsx packages/cli/src/main.ts policy list
```

A `block` is evaluated *before* the request is forwarded, so a blocked call
costs nothing. `warn` forwards the call and returns an `x-costgrid-warnings`
response header. `monitor` only records.

### A cap that does not break production

A hard cap protects the bill by breaking the customer's product, which is why
most teams never switch one on. `--fallback` changes what happens at the
ceiling: over-budget traffic is *downgraded* to a cheaper model instead of
being refused.

```bash
npx tsx packages/cli/src/main.ts policy budget dept:Engineering 500.00 \
  --fallback claude-haiku-4-5 --action block
```

Under $500 nothing changes. Over it, calls keep returning 200 — answered by
Haiku, carrying `x-costgrid-fallback: claude-opus-5->claude-haiku-4-5` so the
caller can tell, and recorded as a violation so the feed says why the model
changed.

The downgrade has to be safe by the same three rules as routing: same
provider, priceable, not a no-op. When it cannot be made — most often because
the traffic is *already* on the fallback model and there is nothing cheaper
left to give — the rule's own action applies again. So:

| Action | Over budget, downgrade possible | Over budget, no downgrade left |
|---|---|---|
| `block` | Answers on the cheap model | **403** — the cap is still a cap |
| `warn` | Answers on the cheap model | Answers, with a warning header |
| `monitor` | Dry run: records what it would have saved | Records only |

Pick `block` for a true ceiling with a soft landing, and `warn` for a rule
that will never refuse a call under any circumstance — accepting that spend
then keeps accruing, just at the cheaper model's rate.

A budget fallback outranks any standing `route` rule: it is the emergency
measure. A separate `block` rule still wins over both, because a refused call
is not going anywhere to be downgraded.

## 9. Let CostGrid do the saving

Reporting a saving is advice. Making it is a product. A route rule sends
matching traffic to a cheaper model:

```bash
# Dry run FIRST. Nothing is rewritten; it records what would have been saved.
npx tsx packages/cli/src/main.ts policy route tenant claude-haiku-4-5 \
  --from claude-opus-5 --action monitor

# Check the estimate, then make it real.
npx tsx packages/cli/src/main.ts report --days 7
npx tsx packages/cli/src/main.ts policy route tenant claude-haiku-4-5 \
  --from claude-opus-5 --action warn
```

The dashboard's Routing tab then shows **realised** savings separately from
**dry-run** ones, with every substitution broken out so the number can be
audited rather than trusted.

Rerouted responses carry `x-costgrid-routed: claude-opus-5->claude-haiku-4-5`,
so a caller can always tell which model actually answered.

Three things CostGrid refuses to do, because each would break something
quietly: route across providers (the request body would be malformed), route
to a model it cannot price (your reported spend would fall to zero), or route
a call that a block rule already refused.

**Always start with `--action monitor`.** Routing is the only feature here that
changes what your code asked for.

## 10. Governing runs, not just calls

An agent run is many calls. A daily budget tells you a team overspent hours
after it happened; it cannot tell you that *this loop* is on its fortieth step
and should stop now. That needs one more header:

| Header | Meaning |
|---|---|
| `x-costgrid-run` | Groups calls into one run |
| `x-costgrid-parent-run` | The run that delegated this one |

```python
headers = {"x-costgrid-run": run_id}                     # one per agent run
headers = {"x-costgrid-run": sub_id,
           "x-costgrid-parent-run": run_id}              # a delegated sub-run
```

Then the caps that matter for agents:

```bash
# Stop a loop. The 21st call in a run is refused; the first twenty are not.
npx tsx packages/cli/src/main.ts policy run-steps tenant 20 --action block

# A ceiling on one run, independent of the monthly budget.
npx tsx packages/cli/src/main.ts policy run-budget agent:chat-bot 2.00 --action block

# Keep it answering instead: over its ceiling, the run drops to a cheaper model.
npx tsx packages/cli/src/main.ts policy run-budget tenant 5.00 \
  --fallback claude-haiku-4-5 --action block

# How deep delegation may go. 0 is a run nobody delegated to.
npx tsx packages/cli/src/main.ts policy run-depth tenant 2 --action block
```

**The one thing to know before relying on any of this: run rules only apply to
calls that carry `x-costgrid-run`.** A call without it is metered as a run of
one, which no run rule can ever fire on. This is deliberate — the alternative is
guessing which calls belong together and refusing traffic on a guess — but it
means a rule can look enabled while covering nothing. `costgrid runs` prints how
much of your traffic carries a run id, and says so plainly when the answer is
none.

Read them back:

```bash
npx tsx packages/cli/src/main.ts runs --days 7     # most expensive runs
npx tsx packages/cli/src/main.ts run <run-id>      # every call, in order
```

```text
  Run checkout-recovery-4471
  ────────────────────────────────────────────────────────────
  9 call(s) · $1.70 · depth 0

    1.  claude-opus-5                        $0.425000  ok
    …
    9.  claude-opus-5                        $0.000000  blocked
       run has made 8 call(s), at its cap of 8
```

## 11. The topology

With runs flowing, CostGrid reads the shape of your fleet out of the traffic
itself — no config file, no diagram to keep current:

- **agent → model**, from metered calls
- **agent → tool**, from the `tool_use` blocks in responses and the `tools` your
  requests declare
- **agent → agent**, from `x-costgrid-parent-run`

The **Topology** tab draws it. Click an agent and it reports what that agent
reaches *directly* and what it reaches *through a delegation* — the second being
the thing a flat policy cannot express and a reachability question has to
answer.

Solid edges were exercised in the window. Dashed edges are capability an agent
holds and has not used: a tool declared on every request but never called is
still reachable, and still the thing a policy has to account for.

Delegation loops are reported rather than judged. An agent that transitively
delegates back to itself is either designed recursion or a runaway, and nothing
here can tell which — a `run-depth` policy bounds it either way.

### What is stored

Tool **names** only. Never arguments.

| Stored | Not stored |
|---|---|
| `refund_customer` | `{"customer_id": "cus_884412", "amount_usd": 420}` |
| `query_db` | the SQL |

A tool name is structural, like a table name, and it is the whole of what a
reachability policy needs. Arguments are content, and content is forwarded and
never kept. Set `COSTGRID_EXTRACT_TOOLS=false` to switch the path off entirely
if your tool names are themselves sensitive.

## 12. The monthly statement

The report above is a trailing window — useful for watching, wrong for
reconciling. Finance works in calendar months, because that is how the provider
invoices, so the statement is its own command:

```bash
npx tsx packages/cli/src/main.ts statement                     # this month, so far
npx tsx packages/cli/src/main.ts statement --month 2026-08     # a closed month
npx tsx packages/cli/src/main.ts statement --month 2026-08 --format csv --out august.csv
```

It gives the month's total and how it moved against the month before, spend by
department, agent and model with each line's share and movement, budget status
(a monthly cap against the month; a daily cap against its *worst day*, plus how
many days went over), and what auto-routing actually saved.

While the month is still running it says so, and projects a month-end figure
from the run rate — labelled a projection, never mixed into the total.

`--format csv` is the spreadsheet finance will actually open: two tables, spend
line items and budget status. Costs carry six decimals rather than two, because
rounding a $0.004 agent to `0.00` would stop the rows summing to the total.
`--format json` keeps money as exact decimal strings for anything downstream.

The same statement is the **Statement** tab in the dashboard, with a month
picker and a *Download CSV* button, served from `/api/statement` and
`/api/statement.csv?month=YYYY-MM`.

Anything the numbers do not cover is stated on the statement rather than left
out: unpriced calls, calls refused by policy (which cost nothing, and whose
counterfactual cost is genuinely unmeasurable because they never ran), upstream
failures, and imported provider history — which is reported beside the totals,
never added to them, because those rows have no team attribution.

## Keeping prices honest

```bash
npm run verify-pricing
```

Fetches each provider's published pricing table and diffs every rate in the
catalog — 53 models across Anthropic and OpenAI. Exit 0 means accurate and
fresh; 1 means a discrepancy or a stale verification date; 2 means a page could
not be fetched or parsed — which is *inconclusive*, not a pass.

If a rate has changed, update `packages/core/src/pricing.ts` and bump that
provider's `verifiedAt` in `CATALOG_PROVENANCE`. Past 45 days the gateway warns at startup and both the
report and dashboard say so.

## Backing up

```bash
npx tsx packages/cli/src/main.ts backup ./costgrid-backup.db
```

Use this rather than `cp`. The database runs in WAL mode, so recent calls live
in a `-wal` sidecar until checkpointed — a plain file copy silently loses them.

## Routing Claude Code through it

Claude Code respects `ANTHROPIC_BASE_URL`, so you can meter your own coding
sessions:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Two caveats. Claude Code authenticates with an OAuth profile by default, and
the gateway swaps in the API key from its own `.env` — so this bills your API
account rather than your Claude subscription. And with a `block` policy active,
a mid-session block surfaces as an API error inside Claude Code. Use `monitor`
first.

## A note on OpenAI streaming

OpenAI omits token usage from a streamed response unless the request asks for
it. CostGrid adds `stream_options: {include_usage: true}` when you have not set
`stream_options` yourself — without it a streamed call cannot be metered at all.

That adds one trailing chunk with an empty `choices` array. Official SDKs
handle it; a hand-rolled parser that assumes `choices[0]` exists might not. Set
`COSTGRID_OPENAI_INJECT_USAGE=false` to leave requests untouched, and accept
that streamed OpenAI calls then show as unpriced.

## What is measured, and what is assumed

Everything in the *spend* section is measured from provider responses: token
counts come from each call's `usage` object, and each token bucket is priced at
its own rate. The two providers report differently — Anthropic's input count
excludes cached tokens, OpenAI's includes them — and each has its own parser.

The *routing* section is a model, not a measurement. Your observed substitution
share is real; the optimum and the headroom figure derive from the assumptions
in `packages/core/src/routing.ts` and are only as good as those assumptions.

If a call uses a model missing from the price catalog, the report says
`UNPRICED` and tells you the total is understated. It never silently records
that traffic as free.
