You are the lead engineer building CostGrid v3: the router that, for every task an agent sends through the CostGrid gateway, picks the model that will do the job well enough for the least money, sends it there, checks the result, learns from it and explains every choice. Work autonomously through the phases below, one at a time, committing and pushing each one, until phase 6 is done or you hit something only the owner can decide.

## Read first, before writing any code

1. `docs/plans/v3-plan.md` (the same as `docs/plans/CostGrid_v3_Plan.docx`). This is the plan: what "best model" means, how the router works, the 18 decisions D1–D18 and the build order.
2. `docs/ARCHITECTURE.md`, `docs/progress/README.md` (what v1 and v2 built, newest at the bottom), `docs/HOSTING.md`, `docs/OPERATIONS.md`, `QUICKSTART.md`.
3. The code that v3 builds on:
   - `packages/core/src/policy.ts`: route rules, budget fallback, `substitutionAllowed`.
   - `packages/core/src/routing.ts`: the fleet substitution model from the original research.
   - `packages/core/src/pricing.ts`: the price catalog, which has an `open` tier with no models yet.
   - `packages/core/src/lcso.ts` and `packages/core/src/verdict.ts`: cost per finished job.
   - `packages/core/src/outcome-detect.ts` and `packages/core/src/task-fingerprint.ts`.
   - `packages/core/src/reasoning.ts`.
   - `packages/db/src/advise.ts`, `autopilot.ts`, `backtest.ts`, `measured.ts`, `run-outcomes.ts`.
   - `packages/gateway/src/server.ts`: the proxy path.
   - `packages/gateway/src/providers/`: the Anthropic, OpenAI, Bedrock and Vertex adapters.
   - `packages/gateway/src/outbound-guard.ts`, `metrics.ts`, `read-pool.ts`.

## Decisions: take the plan's recommendation for every one

The owner has accepted the recommendations. In short:

- **D1:** the website makes no savings claims until there is proof. Do not add any.
- **D2:** "a real saving" means at least 20% lower cost per good job, with quality and jobs finished no worse, over at least 200 jobs per agent.
- **D4:** routing is included in View and control.
- **D5:** add open models through any service that accepts OpenAI-format requests, then routing between Claude and OpenAI in both directions.
- **D6:** each agent opts in to other providers, and the privacy wording changes in the same release.
- **D7:** a small model on the customer's machine labels the kind of task, with simple signals as the fallback. Prompt text is never stored or sent for labelling.
- **D8:** start from public benchmark results, but move no real traffic until the customer's own data supports it.
- **D9:** the default mode is "same quality, lower cost".
- **D10 and D11:**
  - Signals from real use, checks on the answer, and a reported quality score are always on.
  - Side-by-side grading by a stronger model from a provider the customer already uses runs on a 1–2% sample, only when the owner opts in.
  - Owners are offered weekly spot checks.
- **D12:** an optional 0–1 quality score in outcome reports.
- **D13:** the default quality bar is "never worse than the current model".
- **D14:** CostGrid suggests and the owner approves until an agent passes a trial, then it may switch that agent on its own. It always switches back when results get worse. Automatic switching only on agents with quality signals beyond inference.
- **D15:** "cheap first, then step up" is allowed per agent.
- **D16:** about 5% of traffic goes on testing, never on work marked critical.
- **D17:** one model per agent first, then one per request.
- **D18:** quick wins first.

D3 (which businesses' traffic proves it) is the owner's to arrange. It doesn't block building.

## Build order

Mirror the plan's phases. Before starting a phase, write a short design note for it in `docs/plans/v3-progress.md`: what you will build, data model changes, risks. Then build it, test it, and update that file with what was done.

### Phase 1: quick wins that cut cost without changing the model

1. **Lower reasoning effort.** For agents CostGrid already flags as reasoning long but answering short, an owner-approved, measured option to lower the effort level, with before and after on cost per finished job.
2. **Prompt caching.** For agents that re-send a large unchanged prefix without caching it, an opt-in option to add cache breakpoints (Anthropic), measured before and after. Cache writes cost more than plain input, so only keep it where the measurement shows it pays.
3. **Batch processing at half price.** Work that can wait goes through the providers' batch APIs. Batch is asynchronous, so design how callers mark a request deferrable and collect the result, for example a deferred-jobs endpoint, before building. Keep the synchronous proxy path unchanged.

### Phase 2: quality foundations

1. An optional 0–1 quality score on `/v1/costgrid/outcome`.
2. Checks on the answer itself:
   - correct format
   - required fields present
   - not cut off
   - not a refusal
3. Signals from real use: asked again, handed to a person, edited or rejected when the customer's software reports it.
4. **Cost per good job:** a job counts only if it finished and met the quality bar. It sits beside cost per finished job, with a version bump to the LCSO method, and appears on the console and the statement.
5. A decision log: every routing choice with its reason, predicted cost and quality, confidence, and the models it rejected.

### Phase 3: reach

1. An adapter for any OpenAI-format endpoint, with each tenant's own base URL and key.
2. The SSRF guard applied in hosted mode.
3. Prices for open models. Hosts differ, so prices are per host, with the source and date recorded, and tier `open`.
4. **Request and response translation between the Anthropic and OpenAI formats**, covering:
   - streaming
   - tool calls
   - system prompts
   - usage mapping, so cost stays exact

   When a request uses a feature the target can't honour (extended thinking, cache control, provider-specific tools), it is not routed. It stays on its own model, and the decision log says why.
5. Per-agent opt-in to other providers.
6. The privacy wording updated in the app, the docs and the website's privacy card in the same release.

### Phase 4: understanding the task and predicting the outcome

1. Task labelling:
   - **Desktop:** a small model on the customer's machine. Choose a runtime and model that are small and fast, and download the model on first use.
   - **Hosted:** labelling runs on the server.
   - **Fallback:** simple signals.
2. For each candidate model and kind of task: predicted quality, chance of finishing, and cost including reasoning tokens.
3. Predictions start from public benchmarks with their sources recorded, then update from the customer's own outcomes, with a measure of how sure each one is.

### Phase 5: trials and per-agent routing

1. A testing share per agent, never on work marked critical.
2. Side-by-side grading, opt-in and on a sample, with its cost counted in the agent's costs.
3. Owner spot checks in the console.
4. Switch suggestions with an approve button, then automatic switching for agents that passed a trial.
5. Automatic switch-back on any worsening.
6. Every switch recorded in the rule register and the audit log.

### Phase 6: per-request routing and self-checks

1. A model chosen for each request.
2. Cheap first, then step up, per agent.
3. A weekly check of predictions against what happened, which trusts itself less where it was wrong.
4. A check of the grader against the owner's spot checks.
5. **"Which model is best for this agent or this sample task?"** in the console and the API: a ranked answer with quality, cost, reliability, confidence and evidence.

**Stop after phase 6.** Phase 7 (proving savings on real customers, then claims and pricing) needs real traffic and the owner.

## Ground rules

### Repository conventions
- Run `npm run build` before tests; packages import each other's `dist`.
- Run `npm test`, then `node scripts/e2e-smoke.mjs`.
- A new database migration takes the next number after the highest in `packages/db/src/schema*.ts`. When it adds tables or columns:
  - new INTEGER money or time columns go in `COLUMN_WIDTHS` in `packages/db/src/portability.ts`
  - new tables holding a tenant's data go in `TENANT_TABLES` in `packages/db/src/retention.ts`
  - `packages/db/test/postgres.test.ts` must still pass
- Money is in nanodollars as bigint. Ratios are exact.
- Console UI is plain JS in `packages/gateway/web`, and every server string goes through `escapeHtml`.
- Design tokens come from `design-system`.
- Write code and comments in the style around them, and plain, specific English in anything a customer reads.

### The proxy path
- It must stay fast. CostGrid's added latency (`costgrid_preforward_seconds`) has a target of p99 under 50 ms.
- Measure with `npm run bench` before and after anything on the request path.
- Task labelling and prediction must fit inside that budget, or run so they don't block the call.
- Heavy reads go through `ReadPool`.

### Privacy and safety
- Never store prompts or answers; that is a promise on the website.
- Never send a customer's prompt to a provider the agent hasn't opted into.
- A grader sees prompts only when the owner opted in to grading.
- Never refuse a call because routing failed: fall back to the requested model.
- Never claim savings on the website.
- Don't name third-party proxy products in anything public.

### Spending and outside actions
- Make no paid API calls and create no accounts, keys or third-party services without asking first.
- Build and test against stubs, as the existing tests do.

### Each phase
1. Tests for everything new.
2. The full suite green.
3. A self-review of the diff for bugs, and fix what you find.
4. Update `docs/ARCHITECTURE.md`, `QUICKSTART.md` where setup changes, `docs/OPERATIONS.md` for new metrics or alerts, and an entry at the bottom of `docs/progress/README.md`.
5. Commit with a clear message and push the branch.
6. CI (`.github/workflows/ci.yml`) must stay green.

### When something needs the owner
Write the question at the top of `docs/plans/v3-progress.md`, carry on with the parts that don't depend on it, and list it in your end-of-phase summary. Things that need the owner:
- legal or privacy wording going live
- pricing
- a third-party account
- paid calls
- anything that changes what the website promises

Start by reading the files above, then write the phase 1 design note and begin.
