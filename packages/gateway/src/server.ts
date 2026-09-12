import { randomUUID } from "node:crypto";
import {
  estimateSaving,
  evaluatePolicies,
  planFor,
  type PolicyScope,
  priceUsage,
  type RequestContext,
  toUsdString,
  ZERO_COST,
  ZERO_USAGE,
} from "@costgrid/core";
import {
  type AccountsRepository,
  Analytics,
  type CallRecord,
  CostGridRepository,
  type ImportsRepository,
  trailingWindow,
} from "@costgrid/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { registerApi } from "./api.js";
import { readCookie, registerConsole, SESSION_COOKIE } from "./console.js";
import type { GatewayConfig } from "./config.js";
import { registerDashboard } from "./dashboard.js";
import { ADAPTERS, type ProviderAdapter, type StreamUsageCollector } from "./providers/index.js";
import { RateLimiter } from "./ratelimit.js";

const AGENT_HEADER = "x-costgrid-agent";
const DEPARTMENT_HEADER = "x-costgrid-department";
const KEY_HEADER = "x-costgrid-key";

export interface ServerDeps {
  readonly config: GatewayConfig;
  readonly repository: CostGridRepository;
  readonly analytics: Analytics;
  /** Required in hosted mode; absent in self-hosted, where there are no accounts. */
  readonly accounts?: AccountsRepository | undefined;
  readonly imports: ImportsRepository;
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
function identify(
  request: FastifyRequest,
  deps: ServerDeps,
  allowSession = false,
): Caller | undefined {
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

  // A signed-in human reading their own dashboard. Without this a hosted
  // customer would have to paste an API key into their own console to see
  // their own numbers.
  //
  // Only ever enabled for the read-only dashboard API. Browsers attach
  // cookies to cross-site requests, so accepting one on the proxy would let
  // any page on the internet spend a logged-in user's tokens. Spending
  // requires an API key, which a cross-site page cannot obtain.
  if (allowSession) {
    const sessionCaller = identifyBySession(request, deps);
    if (sessionCaller) return sessionCaller;
  }

  if (!deps.config.allowAnonymous) return undefined;
  return {
    tenantId: "local",
    agentId: headerValue(request, AGENT_HEADER) ?? "unattributed",
    department: headerValue(request, DEPARTMENT_HEADER) ?? "Unassigned",
  };
}

/**
 * Resolve a browser session to one of the user's organisations.
 *
 * A user can belong to several, so `?tenant=` selects; otherwise the first
 * membership wins. Membership is always re-checked, so a guessed id in the
 * query string resolves to nothing.
 */
function identifyBySession(request: FastifyRequest, deps: ServerDeps): Caller | undefined {
  const { accounts } = deps;
  if (!deps.config.hosted || accounts === undefined) return undefined;

  const token = readCookie(request, SESSION_COOKIE);
  if (token === undefined) return undefined;

  const session = accounts.resolveSession(token);
  if (!session) return undefined;

  const memberships = accounts.membershipsOf(session.user.id);
  if (memberships.length === 0) return undefined;

  const requested = (request.query as Record<string, unknown> | undefined)?.["tenant"];
  const chosen =
    typeof requested === "string"
      ? memberships.find((m) => m.tenantId === requested)
      : memberships[0];
  if (!chosen) return undefined;

  return { tenantId: chosen.tenantId, agentId: session.user.email, department: "Unassigned" };
}

/**
 * Make a string safe to put in an HTTP header.
 *
 * Warning text is built from customer-chosen policy names, and Node throws on
 * a header value containing anything outside latin-1. A policy named with an
 * arrow or an em dash would otherwise turn every one of that customer's calls
 * into a 500 — the exact production breakage this whole feature exists to
 * avoid, caused by the warning about it.
 */
function headerSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[^\x20-\x7e]/g, "?");
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const { config, repository, analytics, accounts, imports } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const rateLimiter = new RateLimiter();

  if (config.hosted && accounts === undefined) {
    throw new Error("hosted mode requires an AccountsRepository");
  }

  /**
   * Find the credential to spend against for this call.
   *
   * Hosted: the tenant's own key, decrypted per request. Self-hosted: the
   * operator's env-var key, shared by everyone — right for one organisation,
   * wrong for many, which is the whole distinction between the two modes.
   */
  function resolveUpstream(
    adapter: ProviderAdapter,
    tenantId: string,
  ): { apiKey: string; baseUrl: string } | undefined {
    if (config.hosted) {
      const stored = accounts!.revealCredential(tenantId, adapter.id);
      if (!stored) return undefined;
      return { apiKey: stored.apiKey, baseUrl: stored.baseUrl ?? adapter.defaultBaseUrl };
    }

    const apiKey = config.providerKeys[adapter.id];
    if (apiKey === undefined) return undefined;
    return { apiKey, baseUrl: config.providerBaseUrls[adapter.id] ?? adapter.defaultBaseUrl };
  }

  const app = Fastify({
    logger: { level: config.logLevel },
    // A large context window means a large request body; the default 1MB cap
    // would reject legitimate long-document calls.
    bodyLimit: 64 * 1024 * 1024,
  });

  app.get("/health", async () => ({
    status: "ok",
    version: "0.1.0",
    hosted: config.hosted,
    providers: ADAPTERS.filter((a) => config.hosted || config.providerKeys[a.id] !== undefined).map(
      (a) => ({ id: a.id, path: a.path }),
    ),
  }));

  // The dashboard API and the proxy share a process so a self-hosted deploy is
  // one command. In a multi-tenant hosted setting these would be separate
  // services — reporting load must never contend with the metering path.
  registerApi(app, {
    repository,
    analytics,
    imports,
    // Read-only: a session cookie is accepted here and nowhere else.
    tenantOf: (request) => identify(request, deps, true)?.tenantId,
  });
  if (config.hosted) {
    registerConsole(app, {
      config,
      accounts: accounts!,
      repository,
      analytics,
      imports,
      fetchImpl: deps.fetchImpl,
    });
  }
  registerDashboard(app, { hosted: config.hosted });

  /**
   * The proxy, once per provider.
   *
   * Everything provider-specific is reached through `adapter`, so this handler
   * does not know or care which upstream it is talking to. A provider with no
   * configured credential is not registered at all: the caller gets a clean
   * 404 rather than an upstream auth error they cannot act on.
   */
  function proxyHandler(adapter: ProviderAdapter) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const startedAt = Date.now();
      const caller = identify(request, deps);

      if (!caller) {
        return reply.code(401).send({
          type: "error",
          error: { type: "authentication_error", message: "Invalid or missing CostGrid API key." },
        });
      }

      // --- Rate limit, before any work is done on the request ---------------
      const plan = planFor(accounts?.planOf(caller.tenantId) ?? "business");
      const limit = rateLimiter.check(caller.tenantId, plan.rateLimitPerMinute, startedAt);
      reply.header("x-ratelimit-limit", String(limit.limit));
      reply.header("x-ratelimit-remaining", String(limit.remaining));
      reply.header("x-ratelimit-reset", String(Math.ceil(limit.resetAt / 1000)));

      if (!limit.allowed) {
        reply.header("retry-after", String(limit.retryAfterSeconds));
        return reply.code(429).send({
          type: "error",
          error: {
            type: "rate_limit_error",
            message:
              `Rate limit of ${limit.limit} requests/minute exceeded for the ` +
              `${plan.name} plan. Retry in ${limit.retryAfterSeconds}s.`,
          },
        });
      }

      const upstreamCredential = resolveUpstream(adapter, caller.tenantId);
      if (!upstreamCredential) {
        return reply.code(400).send({
          type: "error",
          error: {
            type: "provider_not_configured",
            message: config.hosted
              ? `No ${adapter.id} credential configured for this organisation. ` +
                "Add one in Settings before routing traffic to it."
              : `No ${adapter.id} credential configured. Set ${adapter.apiKeyEnvVar}.`,
          },
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
      const { apiKey, baseUrl } = upstreamCredential;
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

      /*
       * Apply a route rule, if one matched and is not a dry run.
       *
       * This is the only place CostGrid changes what the customer asked for,
       * so it happens once, explicitly, on a copy of the body. `requestedModel`
       * is kept for the record: without it a rerouted call is indistinguishable
       * from one that simply used a cheap model, and the saving is unprovable.
       */
      const route = decision.route;
      const outgoingBody =
        route?.applied === true ? adapter.withModel(request.body, route.toModel) : request.body;

      if (route !== undefined) {
        const substitution = `${route.fromModel}->${route.toModel}`;
        reply.header(
          "x-costgrid-routed",
          route.applied ? substitution : `dry-run:${substitution}`,
        );
        // A downgrade forced by a budget is a different fact about the call
        // than a standing route rule, and a caller may want to degrade its own
        // behaviour (shorter answers, a banner) when it sees one.
        if (route.fallback) {
          reply.header(
            "x-costgrid-fallback",
            route.applied ? substitution : `dry-run:${substitution}`,
          );
        }
      }

      // OpenAI omits usage from streams unless asked; without this every
      // streamed call would meter as zero.
      const prepared = config.injectUsageRequest
        ? adapter.prepareBody(outgoingBody)
        : { body: outgoingBody, injectedUsageRequest: false };

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
      const warnings = [
        ...decision.violations.map((v) => v.reason),
        ...(route?.applied === true ? [route.reason] : []),
      ];
      if (warnings.length > 0) {
        reply.header("x-costgrid-warnings", headerSafe(warnings.join("; ")));
      }

      const record = (over: Partial<CallRecord>): void => {
        const usage = over.usage ?? ZERO_USAGE;
        const model = over.model ?? requestedModel;
        const modifiers = over.modifiers ?? {};
        const computed = priceUsage(model, usage, modifiers);

        /*
         * The counterfactual, for a routed or dry-run call: what these same
         * tokens would have cost on the model the caller asked for.
         *
         * An estimate, and labelled as one everywhere it surfaces — token
         * counts are not invariant across models. For a dry run the served
         * model *is* the requested one, so the comparison is against the model
         * the rule would have used instead.
         */
        let savingEstimate: bigint | undefined;
        if (route !== undefined) {
          savingEstimate = route.applied
            ? estimateSaving(route.fromModel, model, usage, modifiers)
            : estimateSaving(model, route.toModel, usage, modifiers);
        }

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
          ...(route !== undefined
            ? {
                requestedModel: route.fromModel,
                routed: route.applied,
                routeDryRun: !route.applied,
                ...(savingEstimate !== undefined ? { savingEstimate } : {}),
              }
            : {}),
          outcome: over.outcome ?? "ok",
          statusCode: over.statusCode ?? upstream.status,
        } as CallRecord);

        if (decision.violations.length > 0) {
          repository.recordViolations(caller.tenantId, callId, decision.violations, startedAt);
        }
        if (route !== undefined) {
          // Routing shows in the same feed as everything else, so a customer
          // reviewing "what did CostGrid do to my traffic" sees one list.
          repository.recordViolations(
            caller.tenantId,
            callId,
            [
              {
                policyId: route.policyId,
                policyName: route.policyName,
                action: route.applied ? "warn" : "monitor",
                reason: route.reason,
              },
            ],
            startedAt,
          );
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

  // Hosted mode registers every provider, because whether a tenant can use
  // one depends on their own stored credential, not on startup config.
  for (const adapter of ADAPTERS) {
    if (!config.hosted && config.providerKeys[adapter.id] === undefined) continue;
    app.post(adapter.path, proxyHandler(adapter));
  }

  app.get("/v1/costgrid/summary", async (request, reply) => {
    const caller = identify(request, deps, true);
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
