# Quickstart — metering your own LLM usage

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

Five views: Overview (spend, cache hit ratio, per-model/agent/department
breakdowns), Agents (one row per cost line), Routing (your measured
substitution share against the modelled optimum), Policies (rules and the
enforcement feed), and Pricing (the catalog).

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
