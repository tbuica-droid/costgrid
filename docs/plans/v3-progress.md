# CostGrid v3: progress

The plan is `v3-plan.md`. Each phase opens with a short design note, written
before it is built, and closes with what was done.

## Questions for the owner

1. **Privacy wording for other providers (phase 3, D6).** Today the app and
   the website say keys and prompts go "only to OpenAI or Anthropic". With
   per-agent opt-in, an agent's prompts can also go to an open-model service
   the owner connects, or to the other of the two. The drafted replacement is
   in "Phase 3: privacy wording draft" below. It is not live anywhere public.
   The app shows it only on the opt-in screen itself. Please approve it, or
   change it, before the website and the docs' privacy sections are updated.

## Phase 1: quick wins that cut cost without changing the model

### Design note (4 November 2026)

**What gets built**

Three savings that leave the model alone. Each one is opt-in per agent,
starts as a dry run and is measured before and after.

1. **Lower reasoning effort.** A new rule kind, `lower-reasoning`, with a
   target effort level (and optionally a thinking-budget cap). When a request
   asks for more effort than the target, CostGrid lowers it before forwarding.
   A request that names no effort is left alone, because CostGrid does not
   know the provider's default and won't guess it.
   - Anthropic shape: `output_config.effort`, or `thinking.budget_tokens`
     (never below 1,024, which is Anthropic's minimum).
   - OpenAI shape: `reasoning_effort`, or `reasoning.effort`.
   - The advisor suggests it for agents CostGrid already flags as reasoning
     long but answering short, at one level below the effort they most often
     ask for. The owner installs it from the console as a dry run, then
     switches it on.

2. **Prompt caching.** A new rule kind, `add-cache`, for Claude-format
   requests only (Anthropic, Bedrock, Vertex). OpenAI caches automatically,
   so there is nothing to add there.
   - When the request carries no `cache_control` anywhere, CostGrid marks the
     last tool definition and the last system block as cache breakpoints.
     That is the part of a request most likely to be repeated unchanged.
   - A request that already uses caching is never touched: the developer has
     made that choice.
   - The advisor's existing "re-sends a large prompt and reuses none of it"
     finding now carries this rule for Claude agents.

3. **Batch processing at half price.** A deferred-jobs API beside the proxy.
   The synchronous path is unchanged.
   - `POST /v1/costgrid/deferred` takes `{ provider, requests: [{ custom_id,
     params }] }`, where `params` is a normal Messages or Chat Completions
     body. Each request goes through the same policies as a proxied call
     (blocked ones come back in `rejected`, route and adjustment rules apply).
     The rest are sent to the provider's batch API as one batch. The answer is
     `202` with a CostGrid batch id.
   - `GET /v1/costgrid/deferred/:id` returns status and counts, refreshed from
     the provider. `GET /v1/costgrid/deferred/:id/results` passes the
     provider's JSONL results through unchanged. `GET /v1/costgrid/deferred`
     lists an agent's batches.
   - Anthropic: Message Batches API. OpenAI: upload a JSONL file, then create a
     batch on `/v1/chat/completions`. Bedrock and Vertex batch jobs need S3 or
     GCS buckets, so they are refused with a clear message for now.
   - **Privacy holds.** CostGrid stores no prompt and no answer. Requests are
     forwarded straight to the provider the caller chose. A background sweep
     reads the results once the batch has ended, prices each line at the batch
     rate and records it as a call. The answer text lives only in memory while
     it is read. The provider keeps the batch for its own retention period, as
     its documentation says.

**Measuring before and after**

`QuickWins` (in `packages/db`) does this for each adjustment rule that has
been switched on:
- **Before:** the scope's matching calls in the 14 days before the rule went
  live.
- **After:** the calls the rule changed.
- **Compared:** cost per call and, for agent-scoped rules, cost per finished
  job and the share of jobs finished, from `RunOutcomes`. Below 30 calls a
  side the answer is "not enough data".

**Keeping it only where it pays.** An hourly review switches an enforcing
adjustment rule back to a dry run in two cases, writes `policy.quick-win-reverted`
to the audit log and raises an alert:
- The measurement says it costs more.
- For lower reasoning, fewer jobs finished.

Cache writes cost 1.25 times the input rate, so a prefix that isn't actually
reused is caught here.

**Data model (migration 21)**
- `call_adjustments`: one row for each change a rule made, or would have made,
  to a call: tenant, call, policy, kind, change (for example
  `effort:high->low`), applied or dry run, and the time. It goes with its call
  under retention, and it is listed in `TENANT_TABLES` and `COLUMN_WIDTHS`.
- `deferred_batches`: one row per batch, holding these columns: tenant, agent,
  team, provider, the provider's batch id, status, request and result counts,
  created, ended and metered times, and cost. It holds no request content.

**The request path.** Adjustment rules are evaluated with the policies that
are already loaded, and a body is only rewritten when a rule applies. The
change happens before usage injection and signing, so a SigV4 signature
covers the final bytes. Benchmarked before and after with `npm run bench`.

**Risks**
- Lowering effort can make answers worse. It is a dry run first, measured
  against jobs finished, and reverted automatically.
- Cache breakpoints on a prompt below the model's minimum cacheable length do
  nothing and cost nothing. Breakpoints on a prefix that changes every call
  cost 25% more on that part. The hourly review catches this.
- Batch results arrive up to 24 hours later. Callers must mark work as
  deferrable themselves. CostGrid never defers a call on its own.
- The provider batch endpoints have not been tested against live accounts.
  They are built against stubs, like Bedrock and Vertex were.

### Done (4 November 2026)

Built as designed. The main points:

- **Code**
  - Core: `adjust.ts`, with rule kinds `lower-reasoning` and `add-cache`.
  - Database: migration 21, `quick-wins.ts`, `deferred.ts` and `advise-quick-wins.ts`.
  - Gateway: `quick-win-review.ts`, `deferred.ts` and `deferred-clients.ts`.
  - Console: the Limits screen, with a new `console-quick-wins.js`.
  - CLI: `policy lower-reasoning` and `policy cache`.
- **Owner approval.** Owners approve on the Limits screen ("Start changing calls"),
  through a new `setPolicyAction` that starts the rule's live period. Autopilot
  still only creates routing rules, so these always need the owner.
- **Batch.** Requests the policies refuse are returned and not sent. They are not
  recorded as blocked calls, because no call was made. Batch calls record the
  model that answered, not the one asked for, since the request isn't kept.
- **Latency.** CostGrid's added time stayed within noise on `npm run bench`
  (about 2.5 ms p99 after, 3.7 ms before, on the same machine).
- **Tests.** 28 new tests. Full suite: 1,072 passing. The smoke test passes.
- **Flaky test.** `auth-hardening.test.ts` ("limits login attempts per IP") once
  timed out under full-suite load before any change. It passes alone, and it
  passed in every run since.

### Fixes after review (4 November 2026)

- **Effort levels per model.** `effortsAccepted` decides which levels a model
  takes. `minimal` is accepted only by gpt-5, gpt-5-mini and gpt-5-nano. The
  o-series takes low to high, and pro models high only. An unknown model gets
  low to high. The rule, the advisor and the batch endpoint all use it. When
  the model is already at its lowest accepted level, the call is left alone.
- **Failures count.** Cohorts now count failed calls. A `more-errors` verdict
  (at least 5 failures, and failures up by 5 points) is checked first, on any
  sample size. The review runs every five minutes for failures only, and every
  hour in full.
- **Batch body limit.** `/v1/costgrid/deferred` takes up to 64 MiB, the same as
  a proxied call. Other control routes stay at 1 MiB.

## Owner decision: savings claims (4 November 2026)

The owner overrode D1: the website may now claim a lower bill. Claims are tied
to what the product does (batch at half price, cached prompts billed at a
fraction, lower reasoning, cheaper models where they do the job). No measured
percentage is quoted until D2 has been met on real traffic.


## Phase 2: quality foundations

### Design note (4 November 2026)

**What gets built**

1. **A quality score on outcome reports.** `/v1/costgrid/outcome` takes an
   optional `quality`, a number from 0 to 1. It is stored as whole thousandths
   so comparisons are exact. It also takes an optional `signal`: `accepted`,
   `edited`, `rejected` or `handed-off`, for the customer's software to say
   what a person did with the answer.
2. **Checks on the answer.** Each agent can say what a good answer looks like:
   - any format, or JSON;
   - the top-level fields it must have (names only).

   The proxy checks every buffered final answer in memory and records one word
   per call in `calls.answer_check`: `pass`, `cut-off`, `refusal`, `not-json` or
   `missing-field`. A request that ends by asking for a tool is a step, not an
   answer, and is not judged. Streamed answers are judged on how they ended
   (cut off or refused). Their format is not checked, because that would mean
   holding the whole answer. The text is never stored.
3. **Signals from real use.** "Asked again" and "handed to a person" already
   exist. Reported `edited`, `rejected` and `handed-off` signals now count too.
4. **Cost per good job.** A job is good if it finished and nothing says it
   fell short of the quality bar. Falling short means any of:
   - a failed answer check on its last answer;
   - an `edited` or `rejected` signal;
   - a reported score below the agent's bar.

   The bar is set per agent, from 0 to 1, and defaults to 0.5. The plan's
   default of "never worse than the current model" is a relative bar for
   switching models (phase 5), not this one.
   - **Method version.** The LCSO method goes to version 0.2. The result gains
     `counts.good`, `counts.qualityKnown` and `lcso.good` (AI cost per good
     job), plus a flag when quality is known for fewer than half the finished
     jobs. A job with no quality evidence counts as good, and the coverage
     figure says how many were actually judged.
   - **Where it shows.** On the Results screen, with a quality spread:
     - the answer-check pass rate;
     - the reported scores at the 10th, 50th and 90th percentile.

     It is also on the statement.
5. **The decision log.** `routing_decisions` keeps one row for every choice
   CostGrid makes about where or how a call is sent. Phase 2 records route
   rules, budget fallbacks and adjustments. Each row holds:
   - the kind of choice;
   - the requested and chosen model;
   - whether it was applied, or a dry run;
   - the reason;
   - the predicted cost, predicted quality and confidence (empty until
     phase 4 starts predicting);
   - the models rejected, and why.

   The rows are written with the call, after the answer, so nothing is added
   before forwarding.

**Data model (migration 22)**
- `outcomes`: `quality_milli` and `signal`.
- `calls`: `answer_check`.
- `agents`: `answer_format`, `required_fields` (a JSON list of names) and
  `quality_bar_milli`.
- A new `routing_decisions` table. It goes in `TENANT_TABLES`, and its time and
  money columns go in `COLUMN_WIDTHS`.

**Risks**
- A self-reported score is only as good as the software sending it. It is
  shown as "reported by your software", and the coverage says how many jobs
  had one.
- Treating a job with no quality evidence as good flatters the figure where
  evidence is thin. The coverage figure and the flag make that visible rather
  than hiding it.
- JSON checking reads the answer in memory on the response path, after the
  caller already has it, so it adds no delay before forwarding.

### Done (4 November 2026)

Built as designed.
- **Code:**
  - core: `answer-check.ts` and LCSO 0.2;
  - database: migration 22 and `quality.ts`;
  - gateway: `console-quality.ts`, plus answer checks and the decision log in
    `server.ts`;
  - console: `console-quality.js` on Settings and Limits.
- **Latency:** within noise (2.76 ms p99 on `npm run bench`).
- **Tests:** 1,093 passing. The smoke test passes.
- **Not done:**
  - **Streamed answers' format is not checked.** That would mean holding the
    whole answer in memory. A later phase can add it per agent if owners ask.
  - **"Asked again" is not a separate quality signal.** It stays what it was:
    a finished job asked again inside its window is reversed to not finished.


## Phase 3: reach

### Design note (7 November 2026)

**What gets built**

1. **Endpoints for open models.** An owner registers any service that accepts
   OpenAI-format requests (a hosted service, or a model running on their own
   machine), with:
   - its base URL;
   - its key, encrypted like other provider keys (it may have none, for a
     local server);
   - the models it serves.

   A model on an endpoint is named `open:<endpoint>/<model>`, for example
   `open:together/meta-llama/Llama-3.3-70B-Instruct-Turbo`. Callers can send
   to it through `/v1/chat/completions`, and route rules can send traffic
   to it.
2. **The SSRF guard in hosted mode.** An endpoint's address must be a public
   internet address. It is checked when the endpoint is saved and again on
   every call (`guardedFetch`). Desktop and self-hosted installs may point at
   `localhost`, which is where a self-run model usually lives.
3. **Prices for open models, per host.** The same model costs different amounts
   at different hosts, and the prices change often. So the owner enters each
   endpoint's input, output and cached-input price per million tokens, with the
   page they came from and the date. They are stored as exact whole
   nanodollars per million tokens, and every call is priced with exact
   rounding. A model running on the owner's own machine can be priced at zero,
   with its hardware entered as a fixed cost. CostGrid ships no
   built-in open-model prices, because a figure that can't be checked is the
   decay the catalog's provenance rule exists to prevent.
4. **Translation between Claude and OpenAI formats** (`translate.ts` and
   `translate-stream.ts` in core, pure):
   - requests;
   - responses;
   - streams, event by event;
   - system prompts;
   - images;
   - tool definitions, calls and results;
   - tool choice;
   - stop sequences.

   **Usage.** Metering reads the target provider's own usage with its own
   parser, so cost stays exact. Usage is also mapped into the caller's format
   for the caller's benefit: OpenAI's prompt tokens include cached ones,
   Claude's input tokens exclude them.

   **What blocks routing.** A request that uses something the target can't
   honour is not routed. It stays on its own model, a `not-routed` row in the
   decision log says why, and `x-costgrid-not-routed` tells the caller.
   - Claude features: extended thinking, effort settings, cache control,
     documents, citations, server tools, `top_k`, MCP servers.
   - OpenAI features: `n` above 1, log probabilities, response formats,
     audio, penalties, logit bias, reasoning effort, a temperature above 1.
5. **Per-agent opt-in.** `agent_providers` lists, per agent, the destinations
   it may be sent to beyond its own provider: `openai`, `anthropic`, or a
   specific endpoint. Without an entry, a route rule never moves that agent's
   traffic across formats. CostGrid never sends a customer's prompt to a
   provider the agent hasn't opted in to.
6. **Privacy wording.** New wording is drafted for the app, the docs and the
   website. It waits for the owner's approval before going live (question at
   the top of this file). Until then, cross-provider routing is off unless an
   agent has an opt-in, and the app's opt-in screen says plainly where the
   prompts will go.

**Data model (migration 23)**
- `model_endpoints`: an id, a name, the base URL, the encrypted key and the
  hint shown in its place, and creation and update times.
- `endpoint_models`: endpoint, model, price per million tokens (input, output
  and cached input), the source page and the date priced.
- `agent_providers`: agent and destination.

All three are tenant tables. Their new money and time columns go in
`COLUMN_WIDTHS`.

**The proxy.** A route decision can now name a target on another adapter. The
handler resolves the target's adapter, credential and format, then:
1. translates the body;
2. applies the adjustments in the target's format;
3. prepares and signs the request for the target;
4. meters with the target's parser;
5. translates the answer, buffered or streamed, back to the caller's format.

Calls that aren't routed take the same path as today. Benchmarked.

**Risks**
- **Translation loses something the caller relied on.** Anything that can't be
  carried blocks routing, rather than being dropped quietly. Golden tests cover
  each mapping, both ways, and streams event by event.
- **Answers differ between models.** That is what phase 2's checks and phase
  5's trials measure. Routing to an open model is the owner's rule, dry-run
  first.
- **A hosted endpoint can point inwards.** The SSRF guard covers this, on save
  and on every call.
- **A self-entered price can be wrong.** It is shown with its source and date,
  and calls to an endpoint model with no price are recorded as unpriced, never
  as free.

### Phase 3: privacy wording draft (awaiting the owner)

This replaces "Your keys are only ever sent to OpenAI or Anthropic" on the
website's privacy card and in the privacy sections of the docs. It is not live
until the owner approves it.

> **Your keys and prompts go only where you send them.** CostGrid sends each
> request to the AI provider your agent uses, OpenAI or Anthropic. It sends a
> request somewhere else only when you have ticked that destination for that
> agent and set a rule to route it there: the other of the two, or an
> open-model service you connected with your own key. That service then
> handles the request under its own terms. Your keys go only to the service
> they belong to, never to us. CostGrid itself still keeps no prompt and no
> answer.

The console's opt-in table already says, in its own words, what ticking a
destination means, because that's where the decision is made.

### Done (7 November 2026)

Built as designed.
- **Code:**
  - core: `translate.ts`, `translate-stream.ts` and `open-models.ts`;
  - database: migration 23 and `endpoints.ts`, with endpoint keys added to
    master-key rotation;
  - gateway: `cross-route.ts`, `console-endpoints.ts`, the open adapter, and
    the proxy handler resolving a target adapter;
  - console: `console-endpoints.js` on Settings.
- **Latency:** 1.27 ms p99 on `npm run bench`.
- **Not done, deliberately:**
  - **Bedrock and Vertex callers are not translated.** Bedrock streams binary
    frames, and the plan puts both channels later.
  - **Error bodies from another provider are passed through untranslated.**
    The status code is the provider's own.
  - **No saving estimate for open-model routes.** The estimate prices only
    catalog models, so it is skipped there. The measured before-and-after
    still applies.
- **Waiting on the owner:** the privacy wording (question 1).

