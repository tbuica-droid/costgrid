# CostGrid

**A meter and a shut-off valve for LLM API spend.**

Your software calls an LLM API. CostGrid sits in front of that call: it meters
every request against the provider's own reported token counts, attributes the
cost to a team and an agent, enforces the budgets you set *before* the money is
spent, and — when you ask it to — serves the call on a cheaper model instead of
refusing it.

Deployment is one line of configuration. Point your SDK's base URL at CostGrid
and nothing else changes:

```python
client = Anthropic(base_url="https://costgrid.example.com", api_key="unused")
```

**[Try the dashboard](https://costgrid.dev/demo/)** against sample traffic —
no install. Then **[docs/QUICKSTART.md](docs/QUICKSTART.md)**
takes a clean checkout to a real spend report from your own traffic, and
**[docs/TRIAL.md](docs/TRIAL.md)** covers what a free trial involves and what
data stays inside your network (all of it).

---

## What it does

**Meters exactly.** Token counts come from each provider's `usage` object, not
an estimate or a tokenizer guess. Five buckets are priced independently: input,
output, 5-minute cache write, 1-hour cache write, and cache read. Money is
integer nanodollars end to end — never a float, because a float rounds and a
bill has to reconcile. Rates for 53 models across Anthropic and OpenAI are
checked against the providers' published tables by `npm run verify-pricing`,
which fails the build on a discrepancy or a stale verification date.

**Attributes.** Two headers (`x-costgrid-agent`, `x-costgrid-department`) turn a
provider invoice into per-team, per-feature chargeback. Unlabelled traffic is
metered as `unattributed` — a visible cost line rather than a silent gap.

**Enforces before spending.** Budgets per tenant, department or agent; model
allowlists and denylists; output-token caps. Each rule runs in `monitor`
(record only), `warn` (allow, annotate) or `block` (refuse before forwarding, so
the call costs nothing).

**Draws boundaries, not just budgets.** `costgrid policy deny-tool
agent:support refund_customer` stops that agent — and every agent it delegates
to — from being handed that tool. It holds because a model cannot call a tool it
was never given: the tool list is part of the request, so the request is refused
and there is nothing for your harness to execute. No change to your agent
framework, and no trusting the model to respect an instruction. The same rule
is checked again on the way back, for a model that invents a tool name it was
never offered — airtight on a buffered reply, and on a streamed one it cuts
before the arguments are sent. `docs/QUICKSTART.md` states exactly how far each
half goes.

**Degrades instead of breaking.** A cap with `--fallback` downgrades
over-budget traffic to a cheaper model rather than returning 403, so the
customer's product keeps answering. It refuses to make a substitution it cannot
make safely — across providers, or to a model it cannot price.

**Realises the saving.** A route rule sends matching traffic to a cheaper model
and records the counterfactual, so the saving is audited rather than claimed.
Always dry-run first: `--action monitor` changes nothing and still measures what
it would have saved.

**Reports.** A live dashboard, a terminal report, and a monthly statement —
spend by team with movement against last month, budget status, and what routing
saved — exportable as CSV for finance.

**Imports history.** Backfill from each provider's admin API, so the dashboard
is not empty on day one. Imported rows are kept apart from metered ones: they
are daily provider totals with no attribution, and folding them together would
misattribute them.

---

## Repository contents

```
packages/
  core/     Pure domain: money, pricing catalog, usage parsing, policy. No I/O.
  db/       SQLite schema, repositories, read-side analytics, statements.
  gateway/  The proxy: auth, enforcement, metering, dashboard, control plane.
  cli/      Operator surface: keys, policies, reports, statements, backups.
docs/       QUICKSTART (self-hosted), TRIAL (what a trial involves),
            HOSTING (as a service), ARCHITECTURE (decisions and their reasons).
index.html  The product site. thesis.html and dashboard.html are the
            original research write-up and its illustrative dashboard.
demo/       The real dashboard against a captured snapshot, for GitHub Pages.
scripts/    Pricing verification and an end-to-end smoke test.
CostGrid_Token_Cost_Model.xlsx   The forecast model, 2023 to 2030.
```

```bash
npm install && npm run build && npm test
```

**Site:** <https://costgrid.dev> ·
**Dashboard demo:** <https://costgrid.dev/demo/> ·
**Thesis:** <https://costgrid.dev/thesis.html> ·
**Research dashboard:** <https://costgrid.dev/dashboard.html>

---

## The model behind it

CostGrid started from an observation: per-token prices are collapsing and
enterprise AI bills are rising anyway. Unit price is the wrong thing to watch —
spend is price multiplied by volume, and volume usually wins. `thesis.html`,
`dashboard.html` and the spreadsheet are that research, and the routing economics in
`packages/core/src/routing.ts` come straight from it.

**Cost taxonomy.** Tokens are the visible line, not the whole bill. The model
separates the token line from governance, deployment, observability and
change-management costs, and rolls them into a Levelized Cost of AI per *valid*
inference: amortized CapEx plus total OpEx, divided by inferences that actually
cleared policy.

**Routing economics.** Cheaper models are not automatically cheaper.
Open-weight models cost far less per token but carry a misrouting risk that
grows convexly as more high-stakes work is pushed onto them. The model solves
for the substitution share where the marginal token saving equals the marginal
risk penalty, then compares it to what an organisation actually routes today.
The dashboard's Routing tab measures your real share against that optimum; the
gap is the controllable lever.

**Price forecast.** Model tiers decay toward a hardware floor at different
rates. Economy and open-weight tiers halve roughly every 1.1 years, mid-tier
more slowly, and frontier reasoning models resist the curve almost entirely
because of the reasoning premium. Treating "AI prices are falling" as one
number hides that divergence.

**Reading the model.** Two sheets. `Assumptions` holds every input, with blue
text marking cells meant to be changed and a source note beside each hardcoded
number. `Model` is entirely formulas driven by those assumptions. Six modules:
price decay, routing, volume, spend, seat pricing, and EBITDA impact.

The figures in `dashboard.html` describe an illustrative organisation, not a
real one. Every figure in the *product* dashboard is measured from traffic, and an
empty database shows an empty state rather than a plausible chart.

---

## Method notes

Three choices worth stating plainly, since they drive most of the output.

The **risk penalty** on misrouted work is modeled as `k · f · s^N` with `N = 8`,
where `s` is the substitution share and `f` the frontier price. The high
exponent encodes the assumption that routing errors are cheap at the margin and
very expensive in the tail. The coefficient `k` falls over time as the
open-weight ecosystem matures, which pushes the optimal substitution share from
roughly 83% in 2026 toward 90% by 2030.

**Token volume per interaction** follows a logistic curve rather than a growth
rate, because the shift from single chat calls to multi-step agentic
orchestration is a pattern change with a ceiling, not a compounding trend. The
curve is pinned to EY's cost-per-interaction figures for 2023 and 2026.

**Prices decay toward a hardware floor**, not toward zero. The floor is set from
electricity-and-GPU cost benchmarks, so no tier can decline past what inference
physically costs to serve.

These are estimates, and the distinction matters: everything in the *model* is
projected from stated assumptions, while everything the gateway reports is read
from provider responses at runtime. The two are never mixed — the dashboard
labels the modelled figures as modelled.

---

## References

Research underpinning the model. The gap this project addresses is between
visible token spend and the broader operational cost of deploying AI, and these
sources support quantifying it.

**Pricing and cost structure**

- [Tiered Super-Moore's Law: Price Evolution, Production Frontiers, and Market
  Competition in LLM Inference Services](https://arxiv.org/pdf/2603.28576).
  Analyzes the decline in inference costs and the divergence between tiers.
  Source of the price half-lives used in the model.
- [The Total Cost of Agents](https://www.ey.com/en_us/insights/ai/agentic-ai-token-costs),
  EY. Cost per interaction in 2023 versus today. Anchors the volume curve.
- [Predicting token usage before execution](https://arxiv.org/pdf/2604.22750).
  Quantifies how agents consume tokens and how widely cost varies before a task
  completes.
- [Measuring the full lifecycle cost of AI](https://arxiv.org/pdf/2509.02596).
  A framework for costing AI beyond tokens, including deployment and operational
  overhead.
- [Why cheaper models can become more expensive](https://arxiv.org/pdf/2603.23971).
  Shows how reasoning-token consumption can reverse the expected saving from a
  lower-priced model.
- [Does more reasoning create more value?](https://arxiv.org/pdf/2506.06941)
  Additional reasoning tokens do not always improve outcomes and can degrade
  them.
- [Tokenomics](https://www.citadelsecurities.com/news-and-insights/global-macro-strategy/tokenomics/),
  Citadel Securities Global Macro Strategy. Market-level view of token
  economics.

**Governance**

- [AI Risk Management Framework](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf),
  NIST. The foundational framework for AI risk, controls, monitoring, and
  oversight.
- [Agent governance as infrastructure](https://arxiv.org/pdf/2510.25863).
  Governance architectures for operating autonomous agents at scale.
- [Accountability in agentic systems](https://arxiv.org/pdf/2605.23179).
  Who is responsible when agents make decisions, and where governance boundaries
  belong.

**Market context**

- [The state of the AI agent ecosystem](https://arxiv.org/pdf/2602.17753).
  Adoption, transparency, and governance maturity across the agent market.
- [AI Index Report 2026](https://hai.stanford.edu/assets/files/ai_index_report_2026.pdf),
  Stanford HAI. Adoption, model economics, regulation, and investment.

---

## Author

Built by Tomas Buica &mdash; <tomasbuica@outlook.com>.

## License

MIT
