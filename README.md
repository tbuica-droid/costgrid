# CostGrid

**LLM inference cost governance and unit economics.**

CostGrid is a dashboard and forecast model for the real cost of running AI in
production. It started from a simple observation: per-token prices are
collapsing, and enterprise AI bills are rising anyway. Unit price is the wrong
thing to watch. Spend is price multiplied by volume, and volume usually wins.

The project has two parts. The dashboard models a single organization's agent
fleet and shows where its spend actually goes. The forecast model projects token
prices, routing economics, and spend to 2030 from stated assumptions.

**Live dashboard:** https://tbuica-droid.github.io/costgrid

---

## What it does

**Cost taxonomy.** Tokens are the visible line, not the whole bill. The
dashboard separates the token line from governance, deployment, observability,
and change-management costs, and rolls them into a Levelized Cost of AI (LCOAI)
per valid inference: amortized CapEx plus total OpEx, divided by inferences that
actually cleared policy.

**Routing economics.** Cheaper models are not automatically cheaper. Open-weight
models cost far less per token but carry a misrouting risk that grows convexly
as you push more high-stakes work onto them. The model solves for the optimal
substitution share where the marginal token saving equals the marginal risk
penalty, then compares it to what an organization actually routes today. That
gap, not vendor pricing, is the controllable lever.

**Price forecast.** Model tiers decay toward a hardware floor at different
rates. Economy and open-weight tiers halve roughly every 1.1 years, mid-tier
more slowly, and frontier reasoning models resist the curve almost entirely
because of the reasoning premium. Treating "AI prices are falling" as one number
hides that divergence.

---

## Repository contents

| File | What it is |
|---|---|
| `index.html` | The dashboard. Single self-contained file, no build step. |
| `CostGrid_Token_Cost_Model.xlsx` | The forecast model, 2023 to 2030. |

**Running the dashboard.** Open `index.html` in any browser, or use the live
link above. It pulls Tailwind and Chart.js from CDNs, so it needs a network
connection to render.

**Reading the model.** Two sheets. `Assumptions` holds every input, with blue
text marking cells meant to be changed and a source note beside each hardcoded
number. `Model` is entirely formulas driven by those assumptions, so changing an
input propagates through prices, routing, volume, spend, and the EBITDA and exit
modules. Six modules: price decay, routing, volume, spend, seat pricing, and
EBITDA impact.

The figures in the dashboard describe an illustrative organization, not a real
one. They are there to make the model concrete.

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

Cost estimates are exactly that. For authoritative numbers, read usage and
pricing from your provider's API responses at runtime.

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

Built by Tomas Buica.

## License

MIT
