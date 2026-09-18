# Welcome to CostGrid

This is everything you need to go from nothing to a real number, and then to
actually spending less. It assumes no knowledge of how CostGrid works.

There are four weeks of suggestions at the end. You do not have to follow them,
but they are the order that tends to work.

---

## What CostGrid is, in one paragraph

Your software calls an AI API. You change one line so it calls CostGrid
instead, and CostGrid passes the call straight through to the same provider.
Because every call now goes through it, four things become possible that were
not before: you can see what each call cost, you can see which team spent it,
you can stop a call before it breaks a budget, and you can quietly serve it on
a cheaper model instead of failing.

Everything else in the product is a refinement of those four.

---

## Before you start

You need three things:

1. A machine that can run Node 20 or newer, sitting near the service that calls
   the AI provider.
2. Your provider API key. It goes into a file on that machine and never leaves
   it.
3. Ten minutes.

You do **not** need an account with us, a credit card, or a call.

---

## Step 1: install it

```bash
git clone https://github.com/tbuica-droid/costgrid
cd costgrid
npm install
npm run build
```

## Step 2: add your provider key

```bash
cp .env.example .env
```

Open `.env` and put your key in. Nothing here is sent anywhere except to your
provider.

## Step 3: start it

```bash
npx tsx packages/cli/src/main.ts init
npm run gateway
```

The first command creates your local account and prints an API key. **Copy it
now**, it is shown once.

CostGrid is now listening on `http://127.0.0.1:8787`.

## Step 4: point your software at it

This is the only change to your own code, and it is one line.

```python
# Before
client = Anthropic(api_key="sk-ant-...")

# After
client = Anthropic(base_url="http://127.0.0.1:8787", api_key="unused")
```

The same idea works for OpenAI, AWS Bedrock and Google Vertex. Your key now
lives in CostGrid rather than in the service making the call, which is a
security improvement on its own: a leaked service key can be revoked without
rotating your provider key.

**Send some traffic through it**, then:

```bash
npx tsx packages/cli/src/main.ts report
```

If you can see numbers, you are done with setup. Everything below is optional
and makes those numbers more useful.

---

## Step 5: label your traffic

Two optional headers turn one provider invoice into a per-team breakdown.

```
x-costgrid-agent: support-bot
x-costgrid-department: Customer Support
```

Unlabelled traffic still gets measured. It shows up as `unattributed`, which is
a visible line rather than a silent gap.

**This is the highest-value ten minutes in the whole setup.** Without it you
know what you spent. With it you know who spent it, which is the conversation
you actually need to have.

## Step 6: the run header, if you run agents

If your software does multi-step work, send the same run id on every call in
that piece of work:

```
x-costgrid-run: order-8841
```

This unlocks the controls that stop a runaway: a ceiling per run, a cap on
steps, a limit on how far work can be handed onwards. Without it, CostGrid
treats every call as its own run, and those controls have nothing to fire on.
It will tell you when this is the case rather than letting them look like
protection that is not there.

---

## Seeing what you have

**The dashboard.** Open `http://127.0.0.1:8787` in a browser.

**The report.** `npx tsx packages/cli/src/main.ts report`

**A question, in plain English.** If you would rather ask than learn commands:

```bash
npx tsx packages/cli/src/main.ts ask "why did spend go up last week"
```

This one is optional and off until you configure it, because it is the only
part of CostGrid that sends anything outside your network. Run
`ask --show-data` first: it prints exactly what would be sent, and sends
nothing. It runs on your own AI account, it is shown your figures and nothing
else, and every number it quotes is checked against your data.

---

## Setting your first rules

**Always start in watch-only mode.** Every rule takes `--action monitor`, which
records what it would have done and changes nothing at all. Look at a week of
that before you enforce anything.

```bash
# Watch what a $500/month cap on one team would have done
npx tsx packages/cli/src/main.ts policy budget dept:Support 500.00 \
  --window month --action monitor

# Watch what moving a chatty agent to a cheaper model would have saved
npx tsx packages/cli/src/main.ts policy route agent:classifier claude-haiku-4-5 \
  --from claude-opus-5 --action monitor
```

When you are ready to enforce, use `--action block`. And for budgets, consider
this instead:

```bash
npx tsx packages/cli/src/main.ts policy budget dept:Support 500.00 \
  --window month --fallback claude-haiku-4-5 --action block
```

That does not refuse over-budget calls. It serves them on a cheaper model, so
your product keeps answering. **This is the difference between a cap people
turn on and a cap people talk about turning on.**

## Let it tell you what to do

```bash
npx tsx packages/cli/src/main.ts advise
```

This reads your own traffic, proposes specific rules, and replays each one
against your history so you can see what it would have saved **before** you
switch anything on. Every line it prints is a command for you to run, or not.
It never applies anything itself.

---

## The four weeks

### Week 1: measure, change nothing

Get traffic flowing through it and labelled. Set no rules at all. At the end of
the week, run `report` and look at where the money went. That number alone is
usually a surprise.

### Week 2: watch what rules would do

Run `advise`. Create two or three of the rules it suggests, all in
`--action monitor`. They change nothing. You are building confidence, not
saving money yet.

### Week 3: enforce one thing

Pick the rule you are most sure about and switch it to `--action block`, or
give a budget a `--fallback` so it downgrades instead of refusing. Watch what
happens for a few days.

### Week 4: send the statement to whoever owns the budget

```bash
npx tsx packages/cli/src/main.ts statement --format csv --out september.csv
```

Spend by team, how it moved since last month, what the rules saved. This is the
artefact that makes the case internally.

---

## Common questions

**Does anything we send get stored?**
No prompts, no answers, no tool arguments. What is stored is token counts,
model names, costs, timestamps and the labels you chose. This is not a setting,
it is that nothing else is ever written down.

**What happens if CostGrid goes down?**
Those calls fail. It sits in the request path, and that is the price of being
able to stop a call rather than report on it afterwards. Run it next to the
service that uses it, and keep rules in watch-only mode until you trust it.

**Will it slow us down?**
One hop on your own network, and streamed responses pass straight through. In
practice, no.

**How do we stop using it?**
Point your base URL back at the provider. That is the whole revert, and nothing
else in your code has to change.

**What if we have an enterprise discount?**
Tell CostGrid and every figure will match your invoice instead of list price:
`costgrid rates set anthropic --discount 18`, or derive it from a real invoice
total with `costgrid rates derive anthropic --invoiced 4210.55`.

**We use AWS Bedrock or Google Vertex.**
Both work. Neither has yet been run against a live account, so run this first
and it will tell you in a minute whether yours is fine:
`costgrid preflight bedrock`. If it fails, that is a bug on our side, and the
output is written to be pasted straight into an email to me.

**What is it not good at?**
It measures what your *software* spends on AI, not what your staff spend on
chat subscriptions. If your bill is people typing into a browser, there is
nothing here to measure. It also runs on a single server today: right for one
team, not yet right if losing that server would be a crisis.

---

## Getting help

Email **tomasbuica@outlook.com**. It goes to a person, not a ticket queue,
and is usually answered the same day.

If something is broken, the most useful thing you can send is the output of:

```bash
npx tsx packages/cli/src/main.ts report --days 7
```

It contains no prompts and no content, so it is safe to paste.

---

## Deeper reading, when you want it

- `docs/QUICKSTART.md` covers every feature in order, including tool
  boundaries, per-run controls and letting CostGrid act on its own findings.
- `docs/TRIAL.md` covers what the trial involves and what stays in your network.
- `docs/ARCHITECTURE.md` is for whoever on your team wants to read the code
  before running it. The whole thing is public, and it is worth reading.
