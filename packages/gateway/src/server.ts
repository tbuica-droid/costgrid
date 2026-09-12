import { randomUUID } from "node:crypto";
import {
  evaluatePolicies,
  type PolicyScope,
  priceUsage,
  type RequestContext,
  toUsdString,
  ZERO_COST,
  ZERO_USAGE,
} from "@costgrid/core";
import { Analytics, type CallRecord, CostGridRepository, trailingWindow } from "@costgrid/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { registerApi } from "./api.js";
import type { GatewayConfig } from "./config.js";
import { registerDashboard } from "./dashboard.js";
import { ADAPTERS, type ProviderAdapter, type StreamUsageCollector } from "./providers/index.js";

const AGENT_HEADER = "x-costgrid-agent";
const DEPARTMENT_HEADER = "x-costgrid-department";
const KEY_HEADER = "x-costgrid-key";

export interface ServerDeps {
  readonly config: GatewayConfig;
  readonly repository: CostGridRepository;
  readonly analytics: Analytics;
  /** Overridable for tests, which must never reach a real provider. */
  readonly fetchImpl?: typeof fetch;
}

interface Caller {
  readonly tenantId: string;
  readonly agentId: string;
  readonly department: string;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Identify the caller.
 *
 * The agent id is what a budget is attached to, so an unlabelled call is not
 * rejected — it is attributed to `unattributed`, which shows up in the
 * dashboard as an unowned cost line. Dropping the call would lose the spend
 * record; guessing an owner would be worse.
 */
function identify(request: FastifyRequest, deps: ServerDeps): Caller | undefined {
  const presented =
    headerValue(request, KEY_HEADER) ??
    headerValue(request, "authorization")?.replace(/^Bearer\s+/i, "");

  if (presented !== undefined) {
    const resolved = deps.repository.resolveApiKey(presented);
    if (!resolved) return undefined;
    return {
      tenantId: resolved.tenantId,
      agentId: headerValue(request, AGENT_HEADER) ?? resolved.name,
      department: headerValue(request, DEPARTMENT_HEADER) ?? "Unassigned",
    };
  }

  if (!deps.config.allowAnonymous) return undefined;
  return {
    tenantId: "local",
    agentId: headerValue(request, AGENT_HEADER) ?? "unattributed",
    department: headerValue(request, DEPARTMENT_HEADER) ?? "Unassigned",
  };
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const { config, repository, analytics } = deps;
  const doFetch = deps.fetchImpl ?? fetch;

  const app = Fastify({
    logger: { level: config.logLevel },
    // A large context window means a large request body; the default 1MB cap
    // would reject legitimate long-document calls.
    bodyLimit: 64 * 1024 * 1024,
  });

  app.get("/health", async () => ({
    status: "ok",
    version: "0.1.0",
    providers: ADAPTERS.filter((a) => config.providerKeys[a.id] !== undefined).map((a) => ({
      id: a.id,
      path: a.path,
    })),
  }));

  // The dashboard API and the proxy share a process so a self-hosted deploy is
  // one command. In a multi-tenant hosted setting these would be separate
  // services — reporting load must never contend with the metering path.
  registerApi(app, {
    repository,
    analytics,
    tenantOf: (request) => identify(request, deps)?.tenantId,
  });
  registerDashboard(app);

  /**
   * The proxy, once per provider.
   *
   * Everything provider-specific is reached through `adapter`, so this handler
   * does not know or care which upstream it is talking to. A provider with no
   * configured credential is not registered at all: the caller gets a clean
   * 404 rather than an upstream auth error they cannot act on.
   */
  function proxyHandler(adapter: ProviderAdapter, apiKey: string) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const startedAt = Date.now();
      const caller = identify(request, deps);

      if (!caller) {
        return reply.code(401).send({
          type: "error",
          error: { type: "authentication_error", message: "Invalid or missing CostGrid API key." },
        });
      }

      const requestedModel = adapter.modelOf(request.body);
      const streaming = adapter.isStreaming(request.body);

      const context: RequestContext = {
        agentId: caller.agentId,
        department: caller.department,
        model: requestedModel,
        maxOutputTokens: adapter.maxOutputTokensOf(request.body),
      };

      repository.touchAgent(caller.tenantId, caller.agentId, caller.department);

      // --- Enforcement, before a single token is spent ---------------------
      const policies = repository.listPolicies(caller.tenantId);
      const decision = evaluatePolicies(policies, context, (scope: PolicyScope) =>
        repository.spendFor(caller.tenantId, scope, startedAt),
      );

      const baseRecord = {
        tenantId: caller.tenantId,
        agentId: caller.agentId,
        department: caller.department,
        provider: adapter.id,
        startedAt,
        streamed: streaming,
      };

      if (!decision.allowed) {
        const callId = randomUUID();
        const blocked = decision.blockedBy!;

        repository.recordCall({
          ...baseRecord,
          id: callId,
          model: requestedModel,
          durationMs: Date.now() - startedAt,
          usage: ZERO_USAGE,
          cost: ZERO_COST,
          priced: true,
          outcome: "blocked",
          statusCode: 403,
          errorMessage: blocked.reason,
        });
        repository.recordViolations(caller.tenantId, callId, decision.violations, startedAt);

        return reply.code(403).send({
          type: "error",
          error: {
            type: "costgrid_policy_blocked",
            message: `Blocked by CostGrid policy "${blocked.policyName}": ${blocked.reason}`,
            policy_id: blocked.policyId,
          },
        });
      }

      // --- Forward upstream -------------------------------------------------
      const baseUrl = config.providerBaseUrls[adapter.id] ?? adapter.defaultBaseUrl;
      const upstreamHeaders: Record<string, string> = {
        "content-type": "application/json",
        ...adapter.authHeaders(apiKey),
      };
      for (const name of adapter.forwardedRequestHeaders) {
        const value = headerValue(request, name);
        if (value !== undefined) upstreamHeaders[name] = value;
      }
      if (adapter.id === "anthropic" && upstreamHeaders["anthropic-version"] === undefined) {
        upstreamHeaders["anthropic-version"] = "2023-06-01";
      }

      // OpenAI omits usage from streams unless asked; without this every
      // streamed call would meter as zero.
      const prepared = config.injectUsageRequest
        ? adapter.prepareBody(request.body)
        : { body: request.body, injectedUsageRequest: false };

      let upstream: Response;
      try {
        upstream = await doFetch(new URL(adapter.path, baseUrl), {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(prepared.body),
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        repository.recordCall({
          ...baseRecord,
          id: randomUUID(),
          model: requestedModel,
          durationMs: Date.now() - startedAt,
          usage: ZERO_USAGE,
          cost: ZERO_COST,
          priced: true,
          outcome: "error",
          errorMessage: message,
        });
        return reply.code(502).send({
          type: "error",
          error: { type: "upstream_unreachable", message },
        });
      }

      for (const name of adapter.forwardedResponseHeaders) {
        const value = upstream.headers.get(name);
        if (value !== null) reply.header(name, value);
      }
      // Advertise which violations fired without blocking, so a caller can
      // surface a budget warning to its own operator.
      if (decision.violations.length > 0) {
        reply.header("x-costgrid-warnings", decision.violations.map((v) => v.reason).join("; "));
      }

      const record = (over: Partial<CallRecord>): void => {
        const usage = over.usage ?? ZERO_USAGE;
        const model = over.model ?? requestedModel;
        const modifiers = over.modifiers ?? {};
        const computed = priceUsage(model, usage, modifiers);

        // `priced: false` means the cost could not be established — either the
        // model is uncatalogued, or the provider reported no usage. Both must
        // surface as unpriced rather than as free traffic.
        const priced = over.priced === false ? false : computed.priced;

        const callId = over.id ?? randomUUID();
        repository.recordCall({
          ...baseRecord,
          ...over,
          id: callId,
          model,
          durationMs: Date.now() - startedAt,
          usage,
          cost: computed.cost,
          priced,
          modifiers,
          outcome: over.outcome ?? "ok",
          statusCode: over.statusCode ?? upstream.status,
        } as CallRecord);

        if (decision.violations.length > 0) {
          repository.recordViolations(caller.tenantId, callId, decision.violations, startedAt);
        }
      };

      if (streaming && upstream.ok && upstream.body) {
        return streamThrough(adapter, reply, upstream, record, app.log);
      }

      // --- Buffered response ------------------------------------------------
      const text = await upstream.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {
          type: "error",
          error: { type: "upstream_invalid_json", message: text.slice(0, 500) },
        };
      }

      if (!upstream.ok) {
        record({ outcome: "error", errorMessage: `upstream ${upstream.status}` });
        return reply.code(upstream.status).send(payload);
      }

      const parsed = adapter.parseBufferedResponse(payload);
      record({
        // Bill the model that actually ran, which a server-side fallback can change.
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        usage: parsed.usage ?? ZERO_USAGE,
        modifiers: parsed.modifiers,
        ...(parsed.stopReason !== undefined ? { stopReason: parsed.stopReason } : {}),
        ...(parsed.usage === undefined
          ? { priced: false, errorMessage: "response carried no usage; cost not established" }
          : {}),
        outcome: "ok",
      });

      return reply.code(upstream.status).send(payload);
    };
  }

  for (const adapter of ADAPTERS) {
    const apiKey = config.providerKeys[adapter.id];
    if (apiKey === undefined) continue;
    app.post(adapter.path, proxyHandler(adapter, apiKey));
  }

  app.get("/v1/costgrid/summary", async (request, reply) => {
    const caller = identify(request, deps);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });

    const window = trailingWindow(30);
    const summary = analytics.summary(caller.tenantId, window);

    return {
      window,
      totalCostUsd: toUsdString(summary.totalCost, 6),
      calls: summary.calls,
      blockedCalls: summary.blockedCalls,
      erroredCalls: summary.erroredCalls,
      unpricedCalls: summary.unpricedCalls,
      cacheHitRatio: Number(summary.cacheHitRatio.toFixed(4)),
      substitutionShare: Number(
        analytics.substitutionShare(caller.tenantId, window).toFixed(4),
      ),
      byModel: analytics.spendByModel(caller.tenantId, window).map((row) => ({
        model: row.key,
        costUsd: toUsdString(row.cost, 6),
        calls: row.calls,
      })),
      byAgent: analytics.spendByAgent(caller.tenantId, window).map((row) => ({
        agent: row.key,
        costUsd: toUsdString(row.cost, 6),
        calls: row.calls,
      })),
    };
  });

  return app;
}

/**
 * Pipe a streaming response to the caller while metering a copy of it.
 *
 * The client's bytes are written first on every chunk; metering happens after.
 * If the collector ever throws, the caller's stream is unaffected — losing a
 * usage record is recoverable, corrupting a response is not.
 *
 * A stream that ends without trustworthy usage is recorded with `priced: false`
 * rather than as zero cost, so it appears as an unpriced call instead of
 * quietly dragging reported spend down.
 */
async function streamThrough(
  adapter: ProviderAdapter,
  reply: FastifyReply,
  upstream: Response,
  record: (over: Partial<CallRecord>) => void,
  log: FastifyInstance["log"],
): Promise<void> {
  const collector: StreamUsageCollector = adapter.createStreamCollector();
  const decoder = new TextDecoder();

  reply.raw.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const reader = upstream.body!.getReader();
  let aborted = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!reply.raw.write(Buffer.from(value))) {
        // Respect backpressure rather than buffering the whole stream in memory.
        await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
      }
      collector.feed(decoder.decode(value, { stream: true }));
    }
    collector.end();
  } catch (error) {
    aborted = true;
    log.warn({ err: error }, "stream interrupted; usage may be partial");
  } finally {
    reply.raw.end();
  }

  const untrustworthy = aborted || collector.incomplete;
  const reason = aborted
    ? "stream interrupted; usage is partial"
    : collector.incompleteReason;

  record({
    ...(collector.model !== undefined ? { model: collector.model } : {}),
    usage: collector.usage,
    modifiers: collector.modifiers,
    ...(collector.stopReason !== undefined ? { stopReason: collector.stopReason } : {}),
    outcome: untrustworthy ? "error" : "ok",
    ...(untrustworthy ? { priced: false, errorMessage: reason } : {}),
  });
}
