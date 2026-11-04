import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  adjustmentRulesFor,
  applyAdjustments,
  applyRate,
  evaluatePolicies,
  type PolicyScope,
  priceUsage,
  type RequestContext,
  ZERO_USAGE,
} from "@costgrid/core";
import {
  type CallRecord,
  type CostGridRepository,
  type Db,
  type DeferredBatch,
  DeferredBatches,
  FINISHED_STATUSES,
} from "@costgrid/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  anthropicBatchClient,
  BatchApiError,
  type BatchClient,
  type Credential,
  type DeferredRequest,
  openAiBatchClient,
} from "./deferred-clients.js";
import { ADAPTERS, type ProviderAdapter } from "./providers/index.js";

/**
 * Deferred jobs: work that can wait, sent to a provider's batch API at half
 * price.
 *
 * Batch is asynchronous, so it cannot ride the proxy path: a caller marks the
 * work as deferrable by sending it here, gets an id back at once, and collects
 * the results later. The synchronous proxy is untouched.
 *
 *   POST /v1/costgrid/deferred              { provider, requests: [{ custom_id, params }] }
 *   GET  /v1/costgrid/deferred              this agent's batches, newest first
 *   GET  /v1/costgrid/deferred/:id          status and counts
 *   GET  /v1/costgrid/deferred/:id/results  the provider's JSONL, passed through
 *
 * Every request goes through the same policies as a proxied call: a refused one
 * comes back in `rejected` and is not sent, and route and adjustment rules
 * apply. Budgets are checked against spend at submission; the batch's own cost
 * is only known when it ends, so a large batch can pass a budget it then goes
 * over, as a burst of proxied calls can.
 *
 * Privacy: nothing of a request or an answer is stored. Results are read in
 * memory to price each line at the batch rate and, on request, passed back.
 */

export const MAX_DEFERRED_REQUESTS = 10_000;
/**
 * The largest batch body accepted, 64 MiB: the same as one proxied call.
 *
 * Every other /v1/costgrid/ route stays at 1 MiB (api.ts). A batch carries
 * many prompts, so 500 ordinary ones are already several megabytes. Anthropic
 * takes up to 256 MB per batch, but the body is parsed in memory here, and
 * 64 MiB keeps one submission from taking a large share of a small server's
 * memory. Bigger work goes in as several batches.
 */
export const DEFERRED_BODY_LIMIT = 64 * 1024 * 1024;
const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** How often an unfinished batch is asked about, at most. */
const CHECK_EVERY_MS = 60_000;

interface Caller {
  readonly tenantId: string;
  readonly agentId: string;
  readonly department: string;
}

export interface DeferredDeps {
  readonly db: Db;
  readonly repository: CostGridRepository;
  /** An API key caller. Spending never accepts a session cookie. */
  readonly identify: (request: FastifyRequest, allowSession: boolean) => Caller | undefined;
  readonly resolveUpstream: (adapter: ProviderAdapter, tenantId: string) => Credential | undefined;
  readonly fetchImpl: typeof fetch;
  readonly log: { warn(obj: unknown, msg: string): void };
}

export interface DeferredJobs {
  /** Check unfinished batches and price finished ones. Safe to run at any time. */
  sweep(now?: number): Promise<void>;
  meter(batch: DeferredBatch, now?: number): Promise<boolean>;
}

function view(b: DeferredBatch): Record<string, unknown> {
  return {
    id: b.id,
    provider: b.provider,
    status: b.status,
    request_count: b.requestCount,
    succeeded: b.succeededCount,
    errored: b.erroredCount,
    created_at: new Date(b.createdAt).toISOString(),
    ended_at: b.endedAt === null ? null : new Date(b.endedAt).toISOString(),
    // Null until every result has been priced at the batch rate.
    cost_usd: b.meteredAt === null ? null : (Number(b.cost) / 1e9).toFixed(6),
    results_ready: b.resultsRef !== null && FINISHED_STATUSES.has(b.status),
    ...(b.errorMessage !== null ? { error: b.errorMessage } : {}),
  };
}

/** Lines of a JSONL body, read as it arrives rather than all at once. */
async function* lines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (body === null) return;
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line !== "") yield line;
    }
  }
  buffered += decoder.decode();
  if (buffered.trim() !== "") yield buffered.trim();
}

export function registerDeferred(app: FastifyInstance, deps: DeferredDeps): DeferredJobs {
  const { db, repository, resolveUpstream, log } = deps;
  const batches = new DeferredBatches(db);
  const clients: Record<string, BatchClient> = {
    anthropic: anthropicBatchClient(deps.fetchImpl),
    openai: openAiBatchClient(deps.fetchImpl),
  };
  const adapterFor = (id: string) => ADAPTERS.find((a) => a.id === id);

  async function refresh(batch: DeferredBatch, now: number): Promise<DeferredBatch> {
    if (FINISHED_STATUSES.has(batch.status)) return batch;
    if (batch.checkedAt !== null && now - batch.checkedAt < CHECK_EVERY_MS) return batch;
    const adapter = adapterFor(batch.provider)!;
    const cred = resolveUpstream(adapter, batch.tenantId);
    if (cred === undefined) return batch;
    const update = await clients[batch.provider]!.status(batch.providerBatchId, cred);
    batches.updateStatus(batch.id, update, now);
    return batches.get(batch.tenantId, batch.id)!;
  }

  /**
   * Price every result line at the batch rate and record each as a call.
   *
   * All or nothing: the lines are reduced to usage in memory, then every call
   * is written in one transaction. A failure part-way gives the claim back,
   * so the next sweep tries again and nothing is counted twice.
   */
  async function meter(batch: DeferredBatch, now = Date.now()): Promise<boolean> {
    if (!FINISHED_STATUSES.has(batch.status) || batch.meteredAt !== null) return false;
    if (!batches.claimForMetering(batch.id, now)) return false;
    try {
      const adapter = adapterFor(batch.provider)!;
      const client = clients[batch.provider]!;
      const cred = resolveUpstream(adapter, batch.tenantId);
      if (cred === undefined) throw new Error(`no ${batch.provider} credential to read results with`);
      const rate = repository.rateOverride(batch.tenantId, batch.provider);
      const at = batch.endedAt ?? now;
      const records: CallRecord[] = [];
      let total = 0n;

      for (const ref of [batch.resultsRef, batch.errorsRef]) {
        if (ref === null) continue;
        const response = await client.results(ref, cred);
        for await (const line of lines(response.body)) {
          let parsed;
          try {
            parsed = client.parseLine(line);
          } catch {
            continue;
          }
          if (parsed === undefined) continue;
          const base = {
            id: randomUUID(),
            tenantId: batch.tenantId,
            agentId: batch.agentId,
            department: batch.department,
            provider: batch.provider,
            startedAt: at,
            durationMs: Math.max(0, at - batch.createdAt),
            streamed: false,
          };
          if (parsed.response === undefined) {
            records.push({
              ...base,
              model: "unknown",
              usage: ZERO_USAGE,
              cost: priceUsage("unknown", ZERO_USAGE, {}).cost,
              priced: true,
              outcome: "error",
              errorMessage: `batch request ${parsed.customId}: ${parsed.failure ?? "failed"}`,
            });
            continue;
          }
          const read = adapter.parseBufferedResponse(parsed.response);
          const model = read.model ?? "unknown";
          const usage = read.usage ?? ZERO_USAGE;
          const modifiers = { ...read.modifiers, batch: true };
          const computed = priceUsage(model, usage, modifiers);
          const cost = applyRate(computed.cost, rate);
          total += cost.total;
          records.push({
            ...base,
            model,
            usage,
            cost,
            costList: computed.cost,
            priced: read.usage !== undefined && computed.priced,
            modifiers,
            outcome: "ok",
            statusCode: 200,
            ...(read.stopReason !== undefined ? { stopReason: read.stopReason } : {}),
            ...(read.reasoningTokens !== undefined ? { reasoningTokens: read.reasoningTokens } : {}),
          });
        }
      }

      db.transaction(() => {
        for (const r of records) repository.recordCall(r);
        batches.setCost(batch.id, total);
      })();
      return true;
    } catch (error) {
      batches.releaseClaim(batch.id);
      log.warn({ err: error, batch: batch.id }, "pricing a finished batch failed; it will be tried again");
      return false;
    }
  }

  async function sweep(now = Date.now()): Promise<void> {
    for (const batch of batches.pending()) {
      try {
        const current = await refresh(batch, now);
        if (FINISHED_STATUSES.has(current.status)) await meter(current, now);
      } catch (error) {
        log.warn({ err: error, batch: batch.id }, "checking a batch failed; it will be tried again");
      }
    }
  }

  // ------------------------------------------------------------------ routes

  app.post("/v1/costgrid/deferred", { bodyLimit: DEFERRED_BODY_LIMIT }, async (request, reply) => {
    const caller = deps.identify(request, false);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });

    const body = request.body as Record<string, unknown> | undefined;
    const provider = body?.["provider"];
    if (provider !== "anthropic" && provider !== "openai") {
      return reply.code(400).send({
        error:
          "provider must be anthropic or openai. Bedrock and Vertex batch jobs need a storage bucket and are not supported yet.",
      });
    }
    const raw = body?.["requests"];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DEFERRED_REQUESTS) {
      return reply.code(400).send({ error: `requests must be a list of 1 to ${MAX_DEFERRED_REQUESTS} items` });
    }

    const adapter = adapterFor(provider)!;
    const cred = resolveUpstream(adapter, caller.tenantId);
    if (cred === undefined) {
      return reply.code(400).send({ error: `No ${provider} credential is configured for this organisation.` });
    }

    const policies = repository.listPolicies(caller.tenantId);
    const spend = (scope: PolicyScope) => repository.spendFor(caller.tenantId, scope, Date.now());
    const seen = new Set<string>();
    const accepted: DeferredRequest[] = [];
    const rejected: { custom_id: string; reason: string }[] = [];

    for (const item of raw) {
      const entry = item as Record<string, unknown> | null;
      const customId = entry?.["custom_id"];
      const params = entry?.["params"];
      if (typeof customId !== "string" || !CUSTOM_ID.test(customId)) {
        return reply.code(400).send({ error: "each custom_id must be 1 to 64 letters, digits, - or _" });
      }
      if (seen.has(customId)) return reply.code(400).send({ error: `custom_id ${customId} is used twice` });
      seen.add(customId);
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        return reply.code(400).send({ error: `params for ${customId} must be a request body` });
      }
      if ((params as Record<string, unknown>)["stream"] === true) {
        rejected.push({ custom_id: customId, reason: "a batch request cannot stream" });
        continue;
      }

      const reasoning = adapter.reasoningOf?.(params);
      const context: RequestContext = {
        agentId: caller.agentId,
        department: caller.department,
        model: adapter.modelOf(params),
        maxOutputTokens: adapter.maxOutputTokensOf(params),
        declaredTools: adapter.declaredTools(params),
        ...(reasoning === undefined ? {} : { reasoning }),
      };
      const decision = evaluatePolicies(policies, context, spend);
      if (!decision.allowed) {
        rejected.push({ custom_id: customId, reason: `Blocked by CostGrid policy "${decision.blockedBy!.policyName}": ${decision.blockedBy!.reason}` });
        continue;
      }
      const routed = decision.route?.applied === true ? adapter.withModel(params, decision.route.toModel) : params;
      const adjusted = applyAdjustments(
        adjustmentRulesFor(policies, context),
        provider === "openai" ? "openai" : "anthropic",
        routed,
        adapter.modelOf(routed),
      );
      accepted.push({ custom_id: customId, params: adjusted.body });
    }

    if (accepted.length === 0) {
      return reply.code(422).send({ error: "every request was refused; nothing was sent", rejected });
    }

    let submitted;
    try {
      submitted = await clients[provider]!.submit(accepted, cred);
    } catch (error) {
      const status = error instanceof BatchApiError && error.status < 500 ? 400 : 502;
      return reply.code(status).send({ error: error instanceof Error ? error.message : "the provider refused the batch" });
    }

    const now = Date.now();
    const id = `cgb_${randomUUID().replace(/-/g, "")}`;
    batches.create({
      id,
      tenantId: caller.tenantId,
      agentId: caller.agentId,
      department: caller.department,
      provider,
      providerBatchId: submitted.providerBatchId,
      status: submitted.status.status,
      requestCount: accepted.length,
      createdAt: now,
    });
    batches.updateStatus(id, submitted.status, now);
    return reply.code(202).send({ ...view(batches.get(caller.tenantId, id)!), rejected });
  });

  app.get("/v1/costgrid/deferred", async (request, reply) => {
    const caller = deps.identify(request, false);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });
    return { batches: batches.list(caller.tenantId, caller.agentId).map(view) };
  });

  app.get("/v1/costgrid/deferred/:id", async (request, reply) => {
    const caller = deps.identify(request, false);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });
    const { id } = request.params as { id: string };
    const batch = batches.get(caller.tenantId, id);
    if (batch === undefined) return reply.code(404).send({ error: "no such batch" });
    try {
      const current = await refresh(batch, Date.now());
      // Priced in the background, so reading the status never waits on it.
      if (FINISHED_STATUSES.has(current.status) && current.meteredAt === null) void meter(current);
      return view(current);
    } catch (error) {
      log.warn({ err: error, batch: id }, "the provider did not answer about a batch");
      return { ...view(batch), stale: true };
    }
  });

  app.get("/v1/costgrid/deferred/:id/results", async (request, reply) => {
    const caller = deps.identify(request, false);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });
    const { id } = request.params as { id: string };
    const which = (request.query as Record<string, unknown>)["errors"] === "true" ? "errors" : "results";
    const batch = batches.get(caller.tenantId, id);
    if (batch === undefined) return reply.code(404).send({ error: "no such batch" });
    const ref = which === "errors" ? batch.errorsRef : batch.resultsRef;
    if (!FINISHED_STATUSES.has(batch.status) || ref === null) {
      return reply.code(409).send({ error: `no ${which} yet; the batch is ${batch.status}` });
    }
    const cred = resolveUpstream(adapterFor(batch.provider)!, caller.tenantId);
    if (cred === undefined) return reply.code(400).send({ error: "the provider credential is no longer configured" });
    try {
      const upstream = await clients[batch.provider]!.results(ref, cred);
      reply.header("content-type", "application/x-ndjson");
      return reply.send(Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream));
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "could not read results" });
    }
  });

  return { sweep, meter };
}
