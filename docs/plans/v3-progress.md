# CostGrid v3: progress

The plan is `v3-plan.md`. Each phase opens with a short design note, written
before it is built, and closes with what was done.

## Questions for the owner

None yet.

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

