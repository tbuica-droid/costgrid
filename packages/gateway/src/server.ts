import { randomUUID } from "node:crypto";
import {
  evaluatePolicies,
  parseAnthropicUsage,
  priceUsage,
  type PolicyScope,
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
import { SseUsageCollector } from "./sse.js";

const AGENT_HEADER = "x-costgrid-agent";
const DEPARTMENT_HEADER = "x-costgrid-department";
const KEY_HEADER = "x-costgrid-key";

/** Response headers worth passing back; everything else is hop-by-hop or ours to set. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "request-id",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
  "retry-after",
];

export interface ServerDeps {
  readonly config: GatewayConfig;
  readonly repository: CostGridRepository;
  readonly analytics: Analytics;
  /** Overridable for tests, which must never reach the real provider. */
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

function readMaxTokens(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const value = (body as Record<string, unknown>)["max_tokens"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readModel(body: unknown): string {
  if (typeof body !== "object" || body === null) return "unknown";
  const value = (body as Record<string, unknown>)["model"];
  return typeof value === "string" && value !== "" ? value : "unknown";
}

function isStreaming(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  return (body as Record<string, unknown>)["stream"] === true;
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

  app.get("/health", async () => ({ status: "ok", version: "0.1.0" }));

  // The dashboard API and the proxy share a process so a self-hosted deploy is
  // one command. In a multi-tenant hosted setting these would be separate
  // services — reporting load must never contend with the metering path.
  registerApi(app, {
    repository,
    analytics,
    tenantOf: (request) => identify(request, deps)?.tenantId,
  });
  registerDashboard(app);

  app.post("/v1/messages", async (request, reply) => {
    const startedAt = Date.now();
    const caller = identify(request, deps);

    if (!caller) {
      return reply.code(401).send({
        type: "error",
        error: { type: "authentication_error", message: "Invalid or missing CostGrid API key." },
      });
    }

    const body = request.body;
    const requestedModel = readModel(body);
    const streaming = isStreaming(body);

    const context: RequestContext = {
      agentId: caller.agentId,
      department: caller.department,
      model: requestedModel,
      maxOutputTokens: readMaxTokens(body),
    };

    repository.touchAgent(caller.tenantId, caller.agentId, caller.department);

    // --- Enforcement, before a single token is spent -----------------------
    const policies = repository.listPolicies(caller.tenantId);
    const decision = evaluatePolicies(policies, context, (scope: PolicyScope) =>
      repository.spendFor(caller.tenantId, scope, startedAt),
    );

    if (!decision.allowed) {
      const callId = randomUUID();
      const blocked = decision.blockedBy!;

      repository.recordCall({
        id: callId,
        tenantId: caller.tenantId,
        agentId: caller.agentId,
        department: caller.department,
        provider: "anthropic",
        model: requestedModel,
        startedAt,
        durationMs: Date.now() - startedAt,
        streamed: streaming,
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

    // --- Forward upstream ---------------------------------------------------
    const upstreamUrl = new URL("/v1/messages", config.anthropicBaseUrl);
    const upstreamHeaders: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": headerValue(request, "anthropic-version") ?? "2023-06-01",
    };
    // Beta flags are semantically part of the request; dropping one silently
    // changes behaviour, so it is forwarded verbatim.
    const beta = headerValue(request, "anthropic-beta");
    if (beta !== undefined) upstreamHeaders["anthropic-beta"] = beta;

    const abort = AbortSignal.timeout(config.upstreamTimeoutMs);
    let upstream: Response;
    try {
      upstream = await doFetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(body),
        signal: abort,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      repository.recordCall({
        id: randomUUID(),
        tenantId: caller.tenantId,
        agentId: caller.agentId,
        department: caller.department,
        provider: "anthropic",
        model: requestedModel,
        startedAt,
        durationMs: Date.now() - startedAt,
        streamed: streaming,
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

    for (const name of FORWARDED_RESPONSE_HEADERS) {
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
      const priced = priceUsage(model, usage);

      const callId = over.id ?? randomUUID();
      repository.recordCall({
        id: callId,
        tenantId: caller.tenantId,
        agentId: caller.agentId,
        department: caller.department,
        provider: "anthropic",
        model,
        startedAt,
        durationMs: Date.now() - startedAt,
        streamed: streaming,
        usage,
        cost: priced.cost,
        priced: priced.priced,
        outcome: over.outcome ?? "ok",
        statusCode: upstream.status,
        ...over,
      } as CallRecord);

      if (decision.violations.length > 0) {
        repository.recordViolations(caller.tenantId, callId, decision.violations, startedAt);
      }
    };

    if (streaming && upstream.ok && upstream.body) {
      return streamThrough(reply, upstream, record, app.log);
    }

    // --- Buffered response --------------------------------------------------
    const text = await upstream.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { type: "error", error: { type: "upstream_invalid_json", message: text.slice(0, 500) } };
    }

    if (!upstream.ok) {
      record({
        outcome: "error",
        errorMessage: `upstream ${upstream.status}`,
      });
      return reply.code(upstream.status).send(payload);
    }

    const message = payload as Record<string, unknown>;
    record({
      // Bill the model that actually ran, which a server-side fallback can change.
      model: typeof message["model"] === "string" ? message["model"] : requestedModel,
      usage: message["usage"] !== undefined ? parseAnthropicUsage(message["usage"]) : ZERO_USAGE,
      stopReason: typeof message["stop_reason"] === "string" ? message["stop_reason"] : undefined,
      outcome: "ok",
    });

    return reply.code(upstream.status).send(payload);
  });

  app.get("/v1/costgrid/summary", async (request, reply) => {
    const caller = identify(request, deps);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });

    const window = trailingWindow(30);
    const { from, to } = window;
    const summary = analytics.summary(caller.tenantId, window);

    return {
      window: { from, to },
      totalCostUsd: toUsdString(summary.totalCost, 6),
      calls: summary.calls,
      blockedCalls: summary.blockedCalls,
      erroredCalls: summary.erroredCalls,
      unpricedCalls: summary.unpricedCalls,
      cacheHitRatio: Number(summary.cacheHitRatio.toFixed(4)),
      substitutionShare: Number(
        analytics.substitutionShare(caller.tenantId, { from, to }).toFixed(4),
      ),
      byModel: analytics.spendByModel(caller.tenantId, { from, to }).map((row) => ({
        model: row.key,
        costUsd: toUsdString(row.cost, 6),
        calls: row.calls,
      })),
      byAgent: analytics.spendByAgent(caller.tenantId, { from, to }).map((row) => ({
        agent: row.key,
        costUsd: toUsdString(row.cost, 6),
        calls: row.calls,
      })),
    };
  });

  return app;
}

/**
 * Pipe an SSE response to the caller while metering a copy of it.
 *
 * The client's bytes are written first on every chunk; metering happens after.
 * If the collector ever throws, the caller's stream is unaffected — losing a
 * usage record is recoverable, corrupting a response is not.
 */
async function streamThrough(
  reply: FastifyReply,
  upstream: Response,
  record: (over: Partial<CallRecord>) => void,
  log: FastifyInstance["log"],
): Promise<void> {
  const collector = new SseUsageCollector();
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

  record({
    ...(collector.model !== undefined ? { model: collector.model } : {}),
    usage: collector.usage,
    ...(collector.stopReason !== undefined ? { stopReason: collector.stopReason } : {}),
    outcome: aborted || collector.incomplete ? "error" : "ok",
    ...(aborted || collector.incomplete
      ? { errorMessage: "stream ended before completion; usage is partial" }
      : {}),
  });
}
