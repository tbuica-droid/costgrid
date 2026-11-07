# CostGrid v3: progress

The plan is `v3-plan.md`. Each phase opens with a short design note, written
before it is built, and closes with what was done.

## Questions for the owner

Answered on 7 November 2026:

1. **Privacy wording (D6).** Approved. It goes live together with
   cross-provider routing, and the final text goes to the owner first (see
   "Phase 3: privacy wording, final" below).
2. **The local labelling model (D7).** Left out for now. Labels come from the
   built-in signals, and `COSTGRID_LOCAL_LABELLER` is off by default.
3. **Benchmarks (D8).** None. Predictions keep the tier guess and learn from
   the customer's own results.
4. **Graded answers in memory.** Kept, only while spot checks are turned on
   (a switch of its own, migration 27). Turning them off forgets every held
   answer at once. The privacy wording says so.
6. **Website.** The security headers were republished alone, with no design
   change (main `a831135`). The redesign waits until the owner has seen
   screenshots. Pushed history is not rewritten, and future commits carry no
   `Co-Authored-By` line.

Still open: **D3**, the customers whose traffic proves the savings (phase 7).

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

## Phase 4: understanding the task and predicting the outcome

### Design note (7 November 2026)

**What gets built**

1. **Task labels.** Every proxied call gets a kind and a size:
   - **Kinds:** `answer`, `chat`, `summarise`, `extract`, `classify`,
     `write`, `code`, `analyse`, `agent-step`.
   - **Sizes:** `s`, `m`, `l`, from the request's length.

   The label is metadata, like a model name: the words it came from are read
   in memory and never stored or sent anywhere. `calls.task_kind`,
   `task_size` and `labelled_by` hold it.
   - **The signals labeller** (`task-label.ts`, core, pure) is always on and
     the fallback. It reads the last user turn (first 4 KB) and the request's
     shape: tools, tool results, a JSON format, code. That costs microseconds,
     so it runs before forwarding.
   - **The local-model labeller** runs only if its runtime is installed (see
     owner question 2). It embeds the text with a small sentence model
     (all-MiniLM-L6-v2, about 23 MB, downloaded once into the app's data
     folder) and picks the nearest kind. It runs after the answer has gone to
     the caller, so it never adds delay, and it updates the call's label.
     Hosted, it runs on the server.
2. **Predictions** (`predict.ts`, core, pure; inputs gathered by
   `predictions.ts` in the database package). For an agent, a kind of task and
   each candidate model, it predicts:
   - **Quality.** The share of answers that pass the checks and aren't
     reported as below the bar. This is a Beta posterior: a weak prior from
     the model's tier, or from a cited benchmark when one exists, updated
     with the agent's own evidence on that model and kind.
   - **Chance of finishing.** The same method, over finished and not finished.
   - **Cost per call and per finished job, reasoning included.** From the
     agent's own calls on that model where it has them. Otherwise from the
     agent's token profile on its current model, priced at the candidate's
     list price, with the current reasoning share carried over and the
     estimate labelled as one.
   - **How sure it is.** One minus the width of the 90% interval on quality,
     plus the evidence counts.

   Candidates are the catalog models of the agent's own provider and of every
   destination it opted in to, plus priced endpoint models. Retired and
   unpriced models are left out.
3. **"Which model for this?"** `POST /v1/costgrid/predict` takes an agent and
   an optional sample request. The sample is labelled in memory and never
   stored. The answer is a ranked list in the agent's mode (default "same
   quality, lower cost"). The console's version comes in phase 6.

**D8: no traffic moves on a prior.** Predictions inform suggestions and the
decision log. Nothing here routes a call. Phase 5's trials are the gate.

**Data model (migration 24).** `calls`: `task_kind`, `task_size`,
`labelled_by`. Existing calls stay unlabelled and are counted as "not
labelled", never guessed after the fact.

**Risks**
- **Signal labels are coarse.** They're only used to group evidence, and every
  prediction shows its evidence count.
- **A tier prior can be badly wrong for a specific model.** It is weak (worth
  four jobs), labelled, and outweighed by the customer's data quickly.
- **Labelling adds time before forwarding.** The signals labeller is
  benchmarked, and the model labeller runs after the answer.

### Done (7 November 2026)

Built as designed.
- **Code:**
  - core: `task-label.ts` and `predict.ts`;
  - database: migration 24 and `predictions.ts`;
  - gateway: `task-labeller.ts`, `predict-api.ts`, labels in the proxy, and a
    `predictions` read-pool task.
- **Latency:** labelling costs 14 µs on a 400 KB request. The bench varied
  between 2.3 and 6.9 ms p99 across runs, which is this machine's noise; all
  within target.
- **Waiting on the owner:**
  - question 2: bundling the local model's runtime;
  - question 3: which benchmarks to cite.
- **Not done:** the decision log's prediction columns are still empty for
  route rules. Phase 6, which chooses per request, fills them.

## Phase 5: trials and per-agent routing

### Design note (7 November 2026)

**What gets built**

1. **Trials.** A trial tests one candidate model on a share of one agent's
   traffic, 5% by default (D16), against the model it uses now.
   - **Which jobs.** A job is in the trial by a stable hash of its run id (or
     task id), so every call of a job goes to the same model. The trial's
     other jobs are the control.
   - **Calls are tagged.** Each call carries `trial_id` and `trial_arm`
     (`candidate` or `baseline`). The two arms run at the same time, which
     is a fairer comparison than before and after.
   - **Never on critical work.** An agent marked critical gets no trials. A
     request with `x-costgrid-critical: true` is always kept on the baseline.
   - **Cross-format candidates** follow phase 3's rules: the agent must have
     opted in, and the request must translate. Otherwise the job stays on the
     baseline.
2. **Judging a trial** (`trials.ts`):
   - **Compared, per job:** finished share, quality (answer checks, reported
     scores and signals, grades) and cost per good job.
   - **Passes** with at least the minimum jobs on each arm (100 by default)
     when the candidate is no worse on finishing and quality, within 2
     points (D13), and cheaper per good job.
   - **Fails** on worse quality or finishing, or quickly on errors (5 failed
     calls and 5 points above the baseline).
3. **Side-by-side grading** (opt-in per organisation, on a 1 to 2% sample,
   D10 and D11).
   - **What happens.** For a sampled job on a running trial, after the
     caller has its answer, CostGrid sends the same request to the other
     arm's model, then asks a stronger model the customer already uses (the
     grader) which answer is better, with the order shuffled.
   - **What is kept.** The verdict (candidate, baseline or tie), never the
     text.
   - **Cost.** The extra call and the grading call are recorded as the
     agent's calls, marked as grading, so their cost counts in the agent's
     costs.
4. **Owner spot checks.** Each week the console offers a few graded jobs to
   check (see owner question 4). The owner's verdict is stored beside the
   grader's; phase 6 compares them.
5. **Switching (D14).** A passed trial becomes a suggestion with an approve
   button. Approving it creates a route rule for that agent, from the
   baseline model to the candidate. An agent that has had a trial approved
   may be set to switch on its own: a later passed trial is then applied
   without waiting. Only agents with quality evidence beyond inference qualify
   (answer checks with a format, reported scores or signals, or grades).
6. **Switching back.** An hourly review compares each trial-made switch with
   its trial's baseline figures. If quality, finishing or cost per good job
   gets worse, the rule is switched off and an alert says why. Failed calls
   are checked every five minutes, as for quick wins.
7. **Every switch is recorded.** Approve, automatic switch and switch-back are
   each a rule in the register (owner `CostGrid trials` when automatic) and
   an audit-log entry.

**Data model (migration 25)**
- `trials`: id, agent, baseline model, candidate model, share, minimum jobs,
  status (`running`, `passed`, `failed`, `stopped`, `applied` or
  `reverted`), why, started, ended, and the rule it created.
- `calls`: `trial_id`, `trial_arm`, `purpose` (`work` or `grading`).
- `grades`: trial, call, the grader's verdict and model, the owner's verdict,
  and when each was given.
- `agents`: `critical` and `switching` (`suggest` or `auto`).
- `tenant_settings`: `grading` on or off, and the grading share.

**Risks**
- **A trial can hurt the jobs it touches.** The share is small, critical work
  is never touched, and a trial stops itself on errors.
- **Grading costs money.** It is opt-in, on a small sample, and counted in
  the agent's cost.
- **Graders favour long answers and their own family** (the plan's own
  warning). Order is shuffled, and phase 6 checks the grader against the
  owner's spot checks.

### Done (7 November 2026)

Built as designed.
- **Code:**
  - database: migration 25 and `trials.ts`;
  - gateway: trial assignment in the proxy, `grading.ts`, `trial-review.ts`
    and `console-trials.ts`;
  - console: `console-trials.js` (a new Trials page).
- **Latency.** Before forwarding, the trial lookup takes 17 µs. The
  end-to-end bench could not be run cleanly: the machine was under load
  (average 13 to 15) and p99 swung between 6 and 63 ms between identical runs.
  Rerun `npm run bench` on a quiet machine before release.
- **Not done:**
  - **Streamed answers are not graded**, because their text isn't held.
  - **Grading is limited to direct Claude and OpenAI callers.**
- **Waiting on the owner:** question 4, about holding graded answers in memory.


## Phase 6: per-request routing and self-checks

### Design note (7 November 2026)

**What gets built**

1. **A model chosen for each request (D17).** Opt-in per agent
   (`agents.per_request`), and allowed only for agents with an applied
   trial (D14).
   - **The routing table.** A background job builds `routing_table` every
     hour: for each kind of task the agent does, the cheapest model that is
     "same quality" as its current one on the agent's **own measured
     evidence**. At least 30 judged jobs on that kind are needed, never a
     prior (D8).
   - **The proxy only looks up a cached map,** keyed by agent and kind, so
     nothing new is computed before forwarding.
   - **Where it applies.** It applies only when no rule already chose a model
     and no trial is assigning the job. The chosen model must be reachable
     under phase 3's rules.
   - **What is logged.** The decision log row carries the prediction (cost
     per call, quality, confidence) and the models rejected, with why.
2. **Cheap first, then step up (D15).** Per agent: a cheap model, and on for
   buffered requests only, so streams are untouched and speed-sensitive
   agents leave it off.
   - The request goes to the cheap model first.
   - If the answer clearly fails, the same request goes to the model it asked
     for, and the caller gets that answer. Clearly fails means an error, cut
     off, refused, or a failed format check.
   - Both calls are recorded, under the same run, so the cost of stepping up
     counts.
   - Same provider only in this phase. Translation is a route's job, and
     doing it twice on one request is a risk not worth taking yet.
3. **The weekly check of predictions.**
   - **Saved predictions.** Every week the prediction for each agent, kind
     and model in use is saved (`prediction_checks`).
   - **Compared.** A week later, quality and cost per call are compared
     with what happened, and each result is recorded as inside or outside
     its interval.
   - **Trust.** Trust per agent is the share inside the interval over the
     last four checks. Predictions scale their confidence by it and widen
     their intervals where it is low, so the router plays safer where it was
     wrong.
   - **The owner is told.** Results show on the Trials screen, and an alert
     goes out when trust falls below 50%.
4. **Checking the grader against the owner.** Agreement is the share of the
   owner's spot checks (excluding "can't tell") where the grader picked the
   same answer. With 10 or more checks below 70% agreement, grades stop
   counting in trials, and the screen and an alert say so.
5. **"Which model is best for this agent or this sample task?"**
   - **In the console:** a section on the Trials screen. Pick an agent,
     optionally paste a sample request (labelled in memory, never stored),
     and get a ranked table: quality, cost, reliability, confidence and
     evidence.
   - **Over the API:** `POST /v1/costgrid/predict` (phase 4), now with trust
     applied.

**Data model (migration 26)**
- `agents`: `per_request`, `step_up_model`.
- `routing_table`: the per-kind choice, with its prediction, confidence and
  evidence.
- `prediction_checks`: one row per week, agent, kind and model, with the
  prediction, what happened and whether it fell inside the interval.

**Risks**
- **Per-request routing on thin evidence.** It never uses priors, needs 30
  judged jobs per kind, and runs only after an approved trial. Phase 5's
  switch-back watches it too.
- **Stepping up adds delay to failed answers.** It is buffered only and per
  agent, and the decision log shows when it happened.
- **Cheap-first costs more if the cheap model fails often.** Every step-up
  is recorded, so it shows in cost per finished job.

### Done (7 November 2026)

Built as designed.
- **Code:**
  - database: migration 26 and `routing.ts`, with trust in
    `predictions.ts` and grader agreement in `trials.ts`;
  - gateway: `routing-cache.ts`, `self-check.ts`, per-request routing and
    step-up in the proxy, and new routes in `console-trials.ts`;
  - console: the Trials screen gains routing controls, "Which model is best?"
    and the self-checks.
- **Latency:** 2.71 ms p99 on `npm run bench` (load average 8).
- **Not done:**
  - **Cheap-first is same-provider and buffered only**, as designed.
  - **The decision log's prediction columns stay empty for owner-written
    route rules.** Only per-request choices carry predictions.

## v3 build: where it stands

Phases 1 to 6 are built, tested and pushed. Phase 7 (proving savings on real
customers' traffic against D2, then claims and pricing) needs the owner:
D3, the customers who'll send one agent's traffic. The open questions are at
the top of this file.

### Phase 3: privacy wording, final (7 November 2026, waiting for the owner's OK)

This goes live with cross-provider routing, on the website, in the app and in
the docs. It replaces "Your keys are only ever sent to OpenAI or Anthropic,
never to us" on the website's privacy card, and the FAQ answer to "Does it
read my data?".

**Privacy card: "Your keys and prompts go only where you send them"**

> CostGrid sends each request to the AI provider your agent already uses,
> OpenAI or Anthropic. It sends a request anywhere else only when you have
> ticked that destination for that agent and set a rule to route it there:
> the other of the two, or an open-model service you connected with your own
> key. That service then handles the request under its own terms. Each key
> goes only to the service it belongs to, never to us.

**Privacy card: "CostGrid keeps no prompt and no answer"**

> CostGrid reads each request and answer as it passes, to price it and check
> it, and keeps neither. If you turn on grading, a stronger model from a
> provider you already use compares two answers on a small sample of test
> jobs, and only its verdict is kept. If you also turn on spot checks, those
> two answers are held in the app's memory, never on disk, so you can read
> them: at most 50, for up to 24 hours, and gone when the app restarts or you
> turn spot checks off.

**FAQ: "Does it read my data?"**

> It reads each request and answer as it passes, to work out the cost and
> check the answer, and keeps neither. Requests go to the provider your agent
> uses, and elsewhere only where you have opted that agent in. If you turn on
> spot checks, a few graded answers are held in memory, never on disk, for up
> to 24 hours so you can read them.

