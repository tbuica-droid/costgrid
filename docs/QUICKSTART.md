# Quickstart: metering your own LLM usage

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
after `ANTHROPIC_API_KEY=`. That is equally safe. The danger is only the
command line.

**OpenAI too?** Add `OPENAI_API_KEY=` on its own line the same way. Each
provider gets its own route, and a provider with no key serves none:

| Provider | Route on the gateway |
|---|---|
| Anthropic | `POST /v1/messages` |
| OpenAI | `POST /v1/chat/completions` |

Spend from both lands in one tenant view, and a budget policy applies across
them. A cap blown on OpenAI blocks the next Anthropic call.

The gateway holds this credential so the services calling through it never
need it. That indirection is the point: a compromised caller can be cut off in
CostGrid without rotating your provider key.

`.env` is gitignored, along with anything else starting `.env` except the
example. Including a file accidentally *named* after a key.

## 3. Create the local tenant

```bash
npx tsx packages/cli/src/main.ts init
```

This prints an API key once. With `COSTGRID_ALLOW_ANONYMOUS=true` you do not
need it yet, but store it now. It is not recoverable.

## 4. Start the gateway

```bash
set -a && source .env && set +a && npm run gateway
```

It listens on `http://127.0.0.1:8787`.

## 5. Send traffic through it

Any Anthropic SDK works. Point its base URL at the gateway and CostGrid meters
everything that flows through.

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
substitutes its own. So a placeholder is correct here, not a shortcut.

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

Everything on it is read from metered calls. There is no sample data. An empty
database shows you an empty state, not a plausible chart.

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

Under $500 nothing changes. Over it, calls keep returning 200. Answered by
Haiku, carrying `x-costgrid-fallback: claude-opus-5->claude-haiku-4-5` so the
caller can tell, and recorded as a violation so the feed says why the model
changed.

The downgrade has to be safe by the same three rules as routing: same provider,
priceable, not a no-op. When it cannot be made. Most often because the traffic
is *already* on the fallback model and there is nothing cheaper left to give.
The rule's own action applies again. So:

| Action | Over budget, downgrade possible | Over budget, no downgrade left |
|---|---|---|
| `block` | Answers on the cheap model | **403**, the cap is still a cap |
| `warn` | Answers on the cheap model | Answers, with a warning header |
| `monitor` | Dry run: records what it would have saved | Records only |

Pick `block` for a true ceiling with a soft landing, and `warn` for a rule that
will never refuse a call under any circumstance. Accepting that spend then
keeps accruing, just at the cheaper model's rate.

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
one, which no run rule can ever fire on. This is deliberate. The alternative is
guessing which calls belong together and refusing traffic on a guess. But it
means a rule can look enabled while covering nothing. `costgrid runs` prints
how much of your traffic carries a run id, and says so plainly when the answer
is none.

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
itself. No config file, no diagram to keep current:

- **agent → model**, from metered calls
- **agent → tool**, from the `tool_use` blocks in responses and the `tools` your
  requests declare
- **agent → agent**, from `x-costgrid-parent-run`

The **Topology** tab draws it. Click an agent and it reports what that agent
reaches *directly* and what it reaches *through a delegation*. The second being
the thing a flat policy cannot express and a reachability question has to
answer.

Solid edges were exercised in the window. Dashed edges are capability an agent
holds and has not used: a tool declared on every request but never called is
still reachable, and still the thing a policy has to account for.

Delegation loops are reported rather than judged. An agent that transitively
delegates back to itself is either designed recursion or a runaway, and nothing
here can tell which. A `run-depth` policy bounds it either way.

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

## 12. Boundaries: what an agent may not touch

Every rule so far governs money. This one governs an action.

```bash
npx tsx packages/cli/src/main.ts policy deny-tool agent:support refund_customer
```

`support` may no longer be given that tool. And neither may any agent `support`
hands work to. A delegate is how an agent would otherwise walk straight around
the rule, so transitive is the default; `--direct-only` turns it off and has to
be typed on purpose.

### Why this holds

**A model cannot call a tool it was never given.** The tool list is part of the
request, so CostGrid refuses the request before it is forwarded. There is no
`tool_use` block in the response, nothing for your harness to execute, and
nothing to trust the model about. You do not change your agent framework, and
you are not relying on the model to respect an instruction.

That is a stronger guarantee than it first looks, and it is available to CostGrid
because of *where it sits* rather than because of anything clever it does.

### What it does not cover

A tool your code calls **without asking a model first** never appears in a
request, so nothing here sees it. This governs what your agents can decide to
do, not everything your software can do.

The transitive half needs `x-costgrid-parent-run` propagated. Without it the
delegation chain is invisible and only the direct rule can fire. Creating the
rule prints your run coverage for the last 30 days for exactly this reason. A
boundary that cannot see the chain should not be assumed to be holding it.

### The allowlist form

```bash
npx tsx packages/cli/src/main.ts policy allow-tool agent:support search_docs create_ticket
```

Direct-only by design. Inheriting an allowlist down a chain would silently
forbid a delegate's own legitimate tools, turning one narrow rule into an outage
two hops away. **Deny travels; allow does not.**

### Start in monitor

```bash
npx tsx packages/cli/src/main.ts policy deny-tool agent:support refund_customer --action monitor
```

Records what it would have stopped and changes nothing, exactly like every other
rule here.

### The second line: a tool the model invents

The rule above works because a model cannot call a tool it was never given.
That covers the tool list you send. It does not cover a model *inventing* a
tool name it was never offered. Which is rare, and does happen, and a harness
that dispatches by name can find it.

So the same rule is checked again on the way back, against the tool calls the
response actually asks for. Nothing extra to configure.

**On a buffered response** the guarantee is complete: the whole body is checked
before any of it is forwarded, so a denied tool call never reaches you. You get
a `403` with `costgrid_tool_blocked`.

**On a streamed response** it is weaker, and the difference is worth knowing.
Anthropic announces a tool by name in `content_block_start` and streams its
arguments afterwards. CostGrid cuts at the name, so:

- the arguments are never sent
- the stream ends with an `error` event naming the policy, which every official
  SDK raises as an exception
- the tool *name* has already reached you, in the chunk the cut lands on

A tool call with no arguments is not executable, and no harness should try. But
"should" is doing real work in that sentence. **Where the guarantee has to be
absolute, do not stream that traffic**. A buffered response is checked in full
before a byte of it moves.

Under a tool rule, streamed chunks are decoded before being forwarded rather
than after, because a flushed byte cannot be recalled. The decode was already
happening for metering; only the order changes, and only for callers a tool
rule actually reaches.

### These calls cost money, and are recorded as such

A request-side block costs nothing. The call was never made. A response-side
block is different: the provider ran it and will invoice you for it. Those rows
are recorded as normal spend, so your budgets and your monthly statement
reconcile with the bill. What CostGrid did is in the violation feed and in the
403 your caller received, not hidden in a row that reads as free.

For a cut stream the recorded usage is *short*: whatever the model generated
after the cut was never reported back. It understates rather than invents,
which is the right direction for a number that has to reconcile with an
invoice.

### One thing the gateway will not let you do

Tool rules read the tool names out of each request. With
`COSTGRID_EXTRACT_TOOLS=false` they can read nothing, so they would sit in
`policy list` looking like protection while stopping nothing at all. **The
gateway refuses to start** in that state, naming the policies and both ways out.
A boundary that silently stops holding is worse than no boundary, because you
stop watching the thing you believe is covered.

## 13. Advice from your own traffic

```bash
npx tsx packages/cli/src/main.ts advise --days 30
```

CostGrid reads your metered calls, proposes rules, and **replays each one
against the same window** so you can see what it would have done before you
turn it on. It proposes. It never applies. Every line it prints is a command
for you to run, or not.

```
  SAVES MONEY NOW: ranked by what the replay says it would have saved

  1. ticket-classifier could run claude-opus-5 work on claude-haiku-4-5
     900 call(s) averaging 90 output tokens. Short answers, on one of
     the most expensive models you run.

    Replayed: 900 of 900 call(s), would have saved about $23.22
    Prices the same token counts on the cheaper model. Token counts are
    not identical across models, and a smaller model is often more
    verbose, so treat this as an estimate rather than a measurement.

    costgrid policy route agent:ticket-classifier claude-haiku-4-5 \
      --from claude-opus-5 --action monitor
```

### Why it is grouped rather than ranked in one list

A proposal that **saves money now** and one that **bounds a risk** are
different things, and putting them in one column ranked by "money involved"
reads as a lie: the cap on a department's spend touches more money than the
route rule, and saves none of it.

So they are separate, and the same replay result means opposite things in each.
A route rule that would never have fired has nothing to do. A cap that would
never have fired is *correctly sized*. It sits above everything you actually
did, which is exactly where a cap belongs.

### What the numbers mean, precisely

| Basis | What it means | How far to trust it |
|---|---|---|
| `estimated` | The call still happens, priced on the cheaper model | Sound. Assumes token counts carry across models, which is close but not exact |
| `avoided` | The call would not have happened at all | **Not a saving.** Spend that would not have occurred, assuming nothing retried |

That second row is the one to read twice. A blocking rule replayed over history
says "these calls would have been refused". And refused calls do not vanish
quietly. The software that made them would have errored, retried, or degraded.
It is spend prevented, not money saved, and a cap with `--fallback` is usually
what a team actually wants instead.

### Rules it will not replay

Tool boundaries and depth limits are not backtested, and the output says so
rather than printing a confident zero. A tool rule fires on the tool list in a
*request*, and requests are not stored. Only the names, aggregated. Run one in
`--action monitor` for a week instead; that is a measurement rather than a
replay.

### What it will not propose

A rule that could not fire. An agent sending no `x-costgrid-run` header cannot
be protected by a step cap, so none is offered. The output says the header is
the missing piece. This is the same rule the rest of the product follows: a
control that cannot bite must not look like protection.

### What this is not

It is not an AI making decisions about your spend. Every proposal here comes
from a deterministic query over your metered rows, and every number is
reproducible. That boundary is deliberate: **the advisor proposes, the
enforcement engine acts, and the meter stays free of judgement.** Being wrong
in an advisory costs you a rejected suggestion. Being wrong in the meter costs
you a bill that will not reconcile.

## 14. Bedrock and Vertex

Claude through AWS or Google is the same model, reached differently. CostGrid
proxies both.

```bash
# Bedrock. One compound credential, so a single secret rotates atomically.
AWS_BEDROCK_CREDENTIAL=AKIA...:your-secret:us-east-1
# With STS or SSO, append the session token:
AWS_BEDROCK_CREDENTIAL=ASIA...:your-secret:us-east-1:your-session-token

# Vertex. The service-account JSON, exactly as downloaded.
GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email":"...","private_key":"..."}'
GOOGLE_CLOUD_PROJECT=acme-prod
GOOGLE_CLOUD_LOCATION=us-east5
```

Clients keep the paths they already use, so it stays one line of configuration:

```python
# boto3
client = boto3.client("bedrock-runtime", endpoint_url="http://127.0.0.1:8787")

# Anthropic's Bedrock and Vertex SDKs
AnthropicBedrock(base_url="http://127.0.0.1:8787")
AnthropicVertex(base_url="http://127.0.0.1:8787", project_id=..., region=...)
```

### Run the preflight first

**These two channels were built without an AWS or GCP account to test
against.** The AWS signature is verified against Amazon's published example and
the stream decoder against the canonical CRC vector, but nothing in this
project has ever spoken to Bedrock or Vertex. So verify it against your account
before you route anything real through it:

```bash
npx tsx packages/cli/src/main.ts preflight bedrock
npx tsx packages/cli/src/main.ts preflight vertex
```

```text
  PASS  pricing      anthropic.claude-haiku-4-5-v1:0 prices as claude-haiku-4-5 ($1.00/Mtok in, $5.00/Mtok out)
  PASS  route        POST https://bedrock-runtime.us-east-1.amazonaws.com/model/...
  PASS  credentials  built host, x-amz-content-sha256, x-amz-date, authorization
  PASS  request      200 in one call
  PASS  usage        read 42 in / 7 out
```

One real call, naming the exact stage that fails. If `usage` or `route` fails,
that is a bug here rather than in your setup. The output is written to be
pasted straight into an issue.

### Pricing on these channels

**Bedrock and Vertex publish their own rates, per region, and this catalog does
not carry them.** Traffic is priced at the direct-API list rate for the same
model, which is close but not exact.

Make it exact the same way an enterprise discount is made exact. Derive it from
the bill:

```bash
npx tsx packages/cli/src/main.ts rates derive bedrock --invoiced 1840.00 --days 30
```

That figure comes from your AWS bill, so it absorbs the channel's pricing and
any committed-use discount in one number.

## 15. If you buy off list

Most enterprises do. A committed-spend discount, a partner rate, a negotiated
agreement. The catalog only knows list prices, so without telling CostGrid
about it, every figure here reads high and nothing reconciles with your
invoice. That is the worst possible discrepancy for a tool that sells cost
truth, so fix it first.

**If you know your discount:**

```bash
npx tsx packages/cli/src/main.ts rates set anthropic --discount 18
```

**If you would rather derive it from what you were actually billed**. Which is
better, because it captures whatever your agreement really does rather than
what you think it does:

```bash
# Compare a real invoice total against what CostGrid priced the same period at.
npx tsx packages/cli/src/main.ts rates derive anthropic --invoiced 164.00 --days 30
```

```text
Derived 18.00% off list for anthropic: $164.00 invoiced against $200.00 at
catalog prices, over 30 day(s): 200 metered call(s) and 0 imported row(s).
```

Pair it with `costgrid import` and the comparison spans your whole
organisation's history, not just the traffic already routed through the
gateway.

### How it behaves

- **Every figure becomes what you pay.** Spend, budgets, statements, routing
  savings. A $500 budget now bites at $500 of real money, not $500 of list.
- **The catalog price is kept on every row**, so the discount is provable
  rather than asserted, and you can show both to an auditor.
- **Rates are exact rationals, never floats.** 18% off is 8200/10000 and stays
  that way through every multiplication.
- **Per provider.** An Anthropic discount does not touch OpenAI.
- **History keeps the price it was recorded at.** Setting a rate today does not
  rewrite last month; clear it and new calls return to list.

### The guard

A derivation outside 5%–150% of list is refused rather than applied. A
mis-parsed invoice, or a window that does not match the billing period, would
otherwise corrupt every number CostGrid reports. If you are refused, check that
the window matches the invoice and that the invoice covers only that provider.

Traffic CostGrid cannot price is excluded from the comparison and reported as a
warning, because it would otherwise make the derived discount look deeper than
it is.

## 16. The monthly statement

The report above is a trailing window. Useful for watching, wrong for
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
from the run rate. Labelled a projection, never mixed into the total.

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
failures, and imported provider history. Which is reported beside the totals,
never added to them, because those rows have no team attribution.

## Keeping prices honest

```bash
npm run verify-pricing
```

Fetches each provider's published pricing table and diffs every rate in the
catalog. 53 models across Anthropic and OpenAI. Exit 0 means accurate and
fresh; 1 means a discrepancy or a stale verification date; 2 means a page could
not be fetched or parsed. Which is *inconclusive*, not a pass.

If a rate has changed, update `packages/core/src/pricing.ts` and bump that
provider's `verifiedAt` in `CATALOG_PROVENANCE`. Past 45 days the gateway warns at startup and both the
report and dashboard say so.

## Backing up

```bash
npx tsx packages/cli/src/main.ts backup ./costgrid-backup.db
```

Use this rather than `cp`. The database runs in WAL mode, so recent calls live
in a `-wal` sidecar until checkpointed. A plain file copy silently loses them.

## Routing Claude Code through it

Claude Code respects `ANTHROPIC_BASE_URL`, so you can meter your own coding
sessions:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Two caveats. Claude Code authenticates with an OAuth profile by default, and
the gateway swaps in the API key from its own `.env`. So this bills your API
account rather than your Claude subscription. And with a `block` policy active,
a mid-session block surfaces as an API error inside Claude Code. Use `monitor`
first.

## A note on OpenAI streaming

OpenAI omits token usage from a streamed response unless the request asks for
it. CostGrid adds `stream_options: {include_usage: true}` when you have not set
`stream_options` yourself. Without it a streamed call cannot be metered at all.

That adds one trailing chunk with an empty `choices` array. Official SDKs
handle it; a hand-rolled parser that assumes `choices[0]` exists might not. Set
`COSTGRID_OPENAI_INJECT_USAGE=false` to leave requests untouched, and accept
that streamed OpenAI calls then show as unpriced.

## What is measured, and what is assumed

Everything in the *spend* section is measured from provider responses: token
counts come from each call's `usage` object, and each token bucket is priced at
its own rate. The two providers report differently. Anthropic's input count
excludes cached tokens, OpenAI's includes them. And each has its own parser.

The *routing* section is a model, not a measurement. Your observed substitution
share is real; the optimum and the headroom figure derive from the assumptions
in `packages/core/src/routing.ts` and are only as good as those assumptions.

If a call uses a model missing from the price catalog, the report says
`UNPRICED` and tells you the total is understated. It never silently records
that traffic as free.
