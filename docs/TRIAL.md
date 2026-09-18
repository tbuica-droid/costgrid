# The free trial

Thirty days, free, running on your own infrastructure. No card, no sales call.

Stopping is a one-line revert: point your client's base URL back at the
provider and everything keeps working. That is deliberate. A tool that is hard
to remove is a tool you have to be talked into.

## What you are installing

CostGrid is a proxy that sits between your software and the LLM provider. It
forwards each call unchanged, reads the exact token counts out of the response,
prices them, attributes them to whatever label you attach, and. If you ask it
to. Refuses or downgrades a call that would blow a budget.

You run it. There is no CostGrid service in the middle, and no account to
create.

## What leaves your network

Nothing. The gateway talks to your provider and to nobody else.

Prompt and response bodies are forwarded upstream and streamed back untouched.
What is *stored*, in a SQLite file you own, is:

| Stored | Not stored |
|---|---|
| Model name, timestamp, duration | Prompts |
| Token counts per bucket, computed cost | Completions |
| Your `agent` / `department` labels | Tool calls and their arguments |
| Outcome: ok, blocked, upstream error | System prompts |

Your provider API key sits in the gateway's environment, which is the point of
the indirection: the services calling through it no longer need one, so a
compromised service can be cut off in CostGrid without rotating the key.

## The first hour

Follow [QUICKSTART.md](./QUICKSTART.md). In short:

1.  1. `npm install && npm run build` 2. Put your provider key in `.env` (the
   quickstart shows a way that keeps it out of your shell history). 3. `npx tsx
   packages/cli/src/main.ts init`. Creates the local tenant, prints an API key
   once. 4. `npm run gateway`. Listens on `127.0.0.1:8787`. 5. Point one
   service at it and make a call. Open the dashboard.

Five minutes to a first metered call. Start with a single non-critical service
rather than your whole fleet; there is no benefit to switching everything on day
one, and one service is enough to see whether the numbers look right.

## What to do with the thirty days

**Week 1. Measure.** Label your traffic with `x-costgrid-agent` and
`x-costgrid-department`. Do not set a single enforcement rule. The question
this week is only: *does the dashboard tell you something the provider console
does not?* If it does not, stop here and keep your money.

**Week 2. Watch what a rule would do.** Add budgets in `--action monitor`. They
record and nothing else. Look at the enforcement feed and ask whether the rule
would have fired when you wanted it to.

**Week 3. Enforce something small.** Turn one rule to `warn`, or to `block` on
an agent whose failure nobody will notice. If a hard cap makes you nervous. It
should. Use a fallback instead, which downgrades over-budget traffic to a
cheaper model rather than refusing it:

```bash
npx tsx packages/cli/src/main.ts policy budget dept:Engineering 500.00 \
  --fallback claude-haiku-4-5 --action block
```

**Week 4. The statement.** Run `costgrid statement --format csv` and send it to
whoever owns the budget. That conversation is the actual product. If it does
not happen, or lands flat, CostGrid is not worth a line item for you.

## What it costs afterwards

| Plan | Monthly | On metered spend | Calls included | Seats |
|---|---|---|---|---|
| Free | $0 | — | 10,000 | 2 |
| Team | $99 | 2% | 1,000,000 | 10 |
| Business | $499 | 1% | 20,000,000 | 100 |

The percentage falls as volume rises on purpose: the fee should not grow faster
than the value of governing the spend. The routing report tells you what
CostGrid is saving you, so you can check the trade rather than take it on faith.

## If you have an enterprise agreement

CostGrid prices at catalog list by default, so if you buy off list, tell it
your rate with `costgrid rates set <provider> --discount <pct>`, or derive it from
an actual invoice with `costgrid rates derive`. Every figure then reconciles
with what you are billed, and each row keeps its catalog price so the discount
stays provable.

Do this on day one. Reporting 18% high for three weeks and correcting later
costs more trust than it saves time.

## What it will not do for you

Stated up front, because finding out in week three wastes your time:

-  - **Bedrock and Vertex are supported but unproven.** Both adapters exist and
  are tested, but neither has run against a live AWS or GCP account. I did not
  have one. Run `costgrid preflight bedrock` (or `vertex`) before routing
  anything real, and tell me if it fails. - **It governs API spend, not seat
  licences.** If your AI bill is people using a chat product in a browser,
  there is nothing here to meter. That spend is flat and predictable, which is
  why it does not need governing. - **It is in the request path.** If the
  gateway is down, calls through it fail. That is the cost of being able to
  refuse a call rather than report on it afterwards. Run it beside the service
  that calls it. - **One node, SQLite.** Fine for a team; not yet a
  high-availability deployment. The schema is Postgres-portable but the swap
  has not been made. - **No payment processor.** Plan changes record intent;
  there is nothing to charge your card because nothing charges cards yet.

## Getting help during the trial

Email me directly: <tomasbuica@outlook.com>. I read these myself and usually
reply the same day. Bugs are also welcome as issues:
<https://github.com/tbuica-droid/costgrid/issues>.

If something is wrong with the *numbers*. A price that disagrees with your
invoice, a call attributed to the wrong team. That is the highest-priority kind
of bug there is, and worth a report even if you are only evaluating. A cost
tool that is quietly wrong is worse than no cost tool.