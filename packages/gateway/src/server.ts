import { randomUUID } from "node:crypto";
import {
  applyRate,
  applyRateTo,
  estimateSaving,
  evaluatePolicies,
  planFor,
  type PolicyScope,
  type PolicyViolation,
  priceUsage,
  type RateOverride,
  type RequestContext,
  type ToolGuard,
  toolGuardFor,
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
const RUN_HEADER = "x-costgrid-run";
const PARENT_RUN_HEADER = "x-costgrid-parent-run";

/**
 * Run ids come from the caller and are therefore untrusted input: they land in
 * an index, a URL and a terminal. Bound the length and keep them to characters
 * that cannot be mistaken for anything else on the way through.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function runIdOf(request: FastifyRequest, name: string): string | undefined {
  const value = headerValue(request, name);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return RUN_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

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

/**
 * What a response path hands back for recording.
 *
 * `invokedTools` is not a column on the call row — it fans out into its own
 * table — so it rides here rather than widening `CallRecord`.
 */
type RecordOverrides = Partial<CallRecord> & {
  invokedTools?: readonly string[];
  /**
   * Violations found after the request was allowed — a forbidden tool in the
   * response. They are recorded against the same call row as the request-side
   * ones, so "what did CostGrid do to my traffic" stays one list.
   */
  extraViolations?: readonly PolicyViolation[];
};

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

/**
 * Refuse to serve tool boundaries that cannot be enforced.
 *
 * A tool rule reads the tool list out of each request. With extraction off it
 * reads nothing, so it would sit in `policy list` looking like protection
 * while stopping nothing at all.
 *
 * Throwing is the harsher option and the right one. This is a control someone
 * configured deliberately, its failure mode is silent by nature, and boot is
 * the one moment an operator is watching. The message names both ways out, so
 * the fix is one line whichever they choose.
 */
export function assertToolPoliciesEnforceable(
  config: Pick<GatewayConfig, "extractTools">,
  repository: Pick<CostGridRepository, "toolPolicyNames">,
): void {
  if (config.extractTools) return;

  const names = repository.toolPolicyNames();
  if (names.length === 0) return;

  throw new Error(
    `COSTGRID_EXTRACT_TOOLS=false, but ${names.length} enabled tool ` +
      `${names.length === 1 ? "policy" : "policies"} would silently stop enforcing: ` +
      `${names.join(", ")}. Tool rules read the tool names out of each request, so they ` +
      "cannot work with extraction off. Either remove COSTGRID_EXTRACT_TOOLS=false, or " +
      'disable those policies with "costgrid policy disable <policy-id>".',
  );
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

      // Bedrock names the model in the path, so the route parameters are part
      // of the request as much as the body is.
      const requestedModel = adapter.modelOf(
        request.body,
        request.params as Record<string, string | undefined> | undefined,
      );
      const streaming = adapter.isStreaming(request.body);

      const declaredTools = config.extractTools ? adapter.declaredTools(request.body) : undefined;
      const declaredRun = runIdOf(request, RUN_HEADER);
      const parentRun = runIdOf(request, PARENT_RUN_HEADER);

      /*
       * Who handed this work down.
       *
       * Only read when a parent-run header is present, so a fleet that does
       * not propagate run context pays nothing for a feature it cannot use.
       */
      const delegatedFrom =
        parentRun === undefined ? [] : repository.delegationChain(caller.tenantId, parentRun);

      const context: RequestContext = {
        agentId: caller.agentId,
        department: caller.department,
        model: requestedModel,
        maxOutputTokens: adapter.maxOutputTokensOf(request.body),
        ...(declaredTools === undefined ? {} : { declaredTools }),
        delegatedFrom,
      };

      repository.touchAgent(caller.tenantId, caller.agentId, caller.department);

      /*
       * Run context.
       *
       * A caller that propagates `x-costgrid-run` gets run-scoped enforcement;
       * one that does not gets a run of one and is metered exactly as before.
       * The header is optional on purpose — the whole premise is one line of
       * configuration, and a control that demands code changes is a control
       * most fleets never turn on.
       */
      /*
       * Negotiated rates, resolved once per request.
       *
       * A tenant usually has none; when it does, the same one applies to every
       * recording path below, so it is looked up once rather than per write.
       */
      const rateCache = new Map<string, RateOverride | undefined>();
      const rateFor = (provider: string): RateOverride | undefined => {
        if (!rateCache.has(provider)) {
          rateCache.set(provider, repository.rateOverride(caller.tenantId, provider));
        }
        return rateCache.get(provider);
      };

      const callId = randomUUID();
      const runId = declaredRun ?? callId;
      const runStats =
        declaredRun === undefined
          ? undefined
          : repository.runStats(caller.tenantId, declaredRun, parentRun);

      // --- Enforcement, before a single token is spent ---------------------
      const policies = repository.listPolicies(caller.tenantId);
      const decision = evaluatePolicies(
        policies,
        context,
        (scope: PolicyScope) => repository.spendFor(caller.tenantId, scope, startedAt),
        runStats === undefined
          ? undefined
          : { ...runStats, declared: true },
      );

      /*
       * The second line of defence, for a `tool_use` the request never
       * declared — a model inventing a tool name.
       *
       * `undefined` when no tool rule reaches this caller, which is the common
       * case and costs nothing: neither the buffered check below nor the
       * stream reordering happens at all.
       */
      const toolGuard = config.extractTools ? toolGuardFor(policies, context) : undefined;

      const baseRecord = {
        tenantId: caller.tenantId,
        agentId: caller.agentId,
        department: caller.department,
        provider: adapter.id,
        startedAt,
        streamed: streaming,
        runId,
        runDeclared: declaredRun !== undefined,
        ...(parentRun !== undefined ? { parentRunId: parentRun } : {}),
        runDepth: runStats?.depth ?? 0,
      };

      if (!decision.allowed) {
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

      const outgoingBytes = JSON.stringify(prepared.body);

      /*
       * The served model decides the upstream path, not only the body.
       *
       * Bedrock and Vertex put the model in the URL and stream from a
       * different path than they buffer from, so this is resolved after
       * routing has chosen which model actually runs. For the direct APIs it
       * is one fixed path whatever the model.
       */
      const servedModel = route?.applied === true ? route.toModel : requestedModel;
      const upstreamUrl = new URL(adapter.upstreamPath(servedModel, streaming), baseUrl);

      /*
       * Authentication is resolved last, because two channels need the final
       * request to produce it: SigV4 signs the method, the path and the exact
       * body bytes, so anything that rewrites the body — routing, usage
       * injection — has to happen first or the signature will not verify.
       */
      const upstreamHeaders: Record<string, string> = {
        "content-type": "application/json",
        ...(await adapter.authHeaders(apiKey, {
          method: "POST",
          url: upstreamUrl,
          body: outgoingBytes,
        })),
      };
      for (const name of adapter.forwardedRequestHeaders) {
        const value = headerValue(request, name);
        if (value !== undefined) upstreamHeaders[name] = value;
      }
      if (adapter.id === "anthropic" && upstreamHeaders["anthropic-version"] === undefined) {
        upstreamHeaders["anthropic-version"] = "2023-06-01";
      }

      let upstream: Response;
      try {
        upstream = await doFetch(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: outgoingBytes,
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

      const record = (over: RecordOverrides): void => {
        const usage = over.usage ?? ZERO_USAGE;
        const model = over.model ?? requestedModel;
        const modifiers = over.modifiers ?? {};
        const computed = priceUsage(model, usage, modifiers);

        /*
         * The negotiated rate, applied here rather than at read time.
         *
         * Every budget, statement and analytic already reads `cost`, so
         * discounting once at the point of record means none of them can be
         * left behind reporting list prices. The catalog figure travels
         * alongside as `costList`, which is what makes the discount provable
         * instead of asserted.
         */
        const rate = rateFor(adapter.id);
        const effectiveCost = applyRate(computed.cost, rate);

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
          const listSaving = route.applied
            ? estimateSaving(route.fromModel, model, usage, modifiers)
            : estimateSaving(model, route.toModel, usage, modifiers);
          // A saving quoted at list against a bill quoted at the negotiated
          // rate would not reconcile with itself.
          savingEstimate = listSaving === undefined ? undefined : applyRateTo(listSaving, rate);
        }

        // `priced: false` means the cost could not be established — either the
        // model is uncatalogued, or the provider reported no usage. Both must
        // surface as unpriced rather than as free traffic.
        const priced = over.priced === false ? false : computed.priced;


        // `record` runs at most once per request, so reusing the id minted
        // above keeps a synthetic run_id pointing at a call that exists.
        const id = over.id ?? callId;
        repository.recordCall({
          ...baseRecord,
          ...over,
          id,
          model,
          durationMs: Date.now() - startedAt,
          usage,
          cost: effectiveCost,
          costList: computed.cost,
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

        /*
         * Tool names, after the row exists and after the caller has their
         * response. Nothing here is on the critical path, and a failure to
         * record a name must never affect a call that already succeeded.
         */
        if (config.extractTools) {
          try {
            repository.recordTools({
              tenantId: caller.tenantId,
              callId: id,
              runId,
              agentId: caller.agentId,
              invoked: over.invokedTools ?? [],
              granted: declaredTools ?? [],
              at: startedAt,
            });
          } catch (error) {
            app.log.warn({ err: error }, "tool extraction failed");
          }
        }

        const allViolations = [...decision.violations, ...(over.extraViolations ?? [])];
        if (allViolations.length > 0) {
          repository.recordViolations(caller.tenantId, id, allViolations, startedAt);
        }
        if (route !== undefined) {
          // Routing shows in the same feed as everything else, so a customer
          // reviewing "what did CostGrid do to my traffic" sees one list.
          repository.recordViolations(
            caller.tenantId,
            id,
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
        return streamThrough(adapter, reply, upstream, record, app.log, toolGuard);
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

      /*
       * A forbidden tool call in a buffered response never reaches the caller.
       *
       * Unlike a request-side block, this one costs money: the call ran, the
       * tokens are spent, and the row records that faithfully. What the caller
       * gets is an error rather than a response they would act on — and a
       * distinct error type, because "refused before spending" and "refused
       * after" need different retry behaviour from their code.
       */
      const gated =
        toolGuard === undefined
          ? []
          : parsed.invokedTools
              .map((tool) => toolGuard.check(tool))
              .filter((v): v is PolicyViolation => v !== undefined);
      const gateBlock = gated.find((v) => v.action === "block");

      record({
        invokedTools: parsed.invokedTools,
        ...(gated.length > 0 ? { extraViolations: gated } : {}),
        /*
         * Recorded as `ok` even though the caller received a 403, because
         * `blocked` means "cost nothing" everywhere downstream — every spend
         * query, every budget and the monthly statement sum only `ok` rows.
         * This call reached the provider and will appear on their invoice, so
         * filing it as blocked would hide real money from the one product
         * whose job is to not hide money.
         *
         * The fact that CostGrid withheld the response is not lost: it is in
         * the status code, the error message and the violation feed.
         */
        ...(gateBlock !== undefined
          ? { statusCode: 403, errorMessage: gateBlock.reason }
          : {}),
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

      if (gateBlock !== undefined) {
        return reply.code(403).send({
          type: "error",
          error: {
            type: "costgrid_tool_blocked",
            message:
              `Blocked by CostGrid policy "${gateBlock.policyName}": ${gateBlock.reason}. ` +
              "The call was made and is billed; the response was withheld.",
            policy_id: gateBlock.policyId,
          },
        });
      }

      return reply.code(upstream.status).send(payload);
    };
  }

  // Hosted mode registers every provider, because whether a tenant can use
  // one depends on their own stored credential, not on startup config.
  for (const adapter of ADAPTERS) {
    if (!config.hosted && config.providerKeys[adapter.id] === undefined) continue;
    app.post(adapter.path, proxyHandler(adapter));
  }

  /**
   * Tell CostGrid whether a run achieved what it was for.
   *
   * The one fact it cannot observe. Everything else here is read off the wire;
   * this has to be reported by the software that did the work, because tokens
   * do not say whether the answer was any good.
   *
   * One optional call, and nothing breaks without it. What you lose by
   * skipping it is the only figure that says whether the money bought
   * anything: cost per result that worked.
   */
  app.post("/v1/costgrid/outcome", async (request, reply) => {
    const caller = identify(request, deps, true);
    if (!caller) return reply.code(401).send({ error: "unauthorized" });

    const body = request.body as Record<string, unknown> | undefined;
    const runId = typeof body?.["run_id"] === "string" ? body["run_id"].trim() : "";
    if (runId === "") {
      return reply.code(400).send({
        error: "run_id is required: the id you sent as x-costgrid-run on the calls in this run",
      });
    }
    if (typeof body?.["success"] !== "boolean") {
      return reply.code(400).send({ error: "success must be true or false" });
    }

    /*
     * A label groups outcomes; it is not a place to describe what happened.
     * Capped and stripped so it cannot quietly become a field where a customer
     * puts content we have promised never to store.
     */
    const rawLabel = body["label"];
    const label =
      typeof rawLabel === "string" && rawLabel.trim() !== ""
        ? rawLabel.trim().slice(0, 64)
        : undefined;

    repository.recordOutcome({
      tenantId: caller.tenantId,
      runId,
      succeeded: body["success"],
      label,
      at: Date.now(),
    });

    return reply.code(202).send({ recorded: true, run_id: runId });
  });

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
  record: (over: RecordOverrides) => void,
  log: FastifyInstance["log"],
  toolGuard: ToolGuard | undefined,
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
  let gateBlock: PolicyViolation | undefined;
  const gated: PolicyViolation[] = [];
  let checkedTools = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      /*
       * Metering before forwarding, but only when a tool rule is in force.
       *
       * Ordinarily a chunk is written first and metered afterwards, because
       * metering must never delay a byte. A stream that has to be cut cannot
       * afford that order: once a chunk is flushed the caller has it, and
       * there is no un-sending it. So under a guard the chunk is decoded
       * first, and a chunk that carries a forbidden tool is never written.
       *
       * The cut lands where it does because of the wire format. Anthropic
       * announces a tool by name in `content_block_start`, and streams its
       * arguments afterwards as `input_json_delta`. Cutting on the name means
       * the arguments never arrive, so what the caller holds is a tool call
       * with no input, followed by an error event.
       *
       * Say what that is and is not. CostGrid guarantees the arguments are
       * never sent and the stream ends in an error. It cannot guarantee what a
       * given harness does with a name and no arguments — no harness should
       * execute an incomplete tool call, but "should" is doing work in that
       * sentence. Where the guarantee has to be absolute, do not stream: a
       * buffered response is checked in full before any of it is forwarded.
       */
      if (toolGuard !== undefined) {
        collector.feed(decoder.decode(value, { stream: true }));

        const seen = collector.invokedTools;
        for (; checkedTools < seen.length; checkedTools += 1) {
          const violation = toolGuard.check(seen[checkedTools]!);
          if (violation === undefined) continue;
          gated.push(violation);
          if (violation.action === "block") gateBlock = violation;
        }

        if (gateBlock !== undefined) break;

        if (!reply.raw.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
        }
        continue;
      }

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
    if (gateBlock !== undefined) {
      // A stream that simply stops leaves the caller debugging a network fault
      // that never happened.
      const event = adapter.streamError?.(
        `Blocked by CostGrid policy "${gateBlock.policyName}": ${gateBlock.reason}. ` +
          "The tool arguments were not sent.",
      );
      if (event !== undefined) reply.raw.write(event);
    }
    reply.raw.end();
  }

  const untrustworthy = aborted || collector.incomplete;
  const reason = aborted
    ? "stream interrupted; usage is partial"
    : collector.incompleteReason;

  record({
    invokedTools: collector.invokedTools,
    ...(collector.model !== undefined ? { model: collector.model } : {}),
    usage: collector.usage,
    modifiers: collector.modifiers,
    ...(collector.stopReason !== undefined ? { stopReason: collector.stopReason } : {}),
    ...(gated.length > 0 ? { extraViolations: gated } : {}),
    /*
     * A cut stream stays `ok`, for the same reason as the buffered case: the
     * provider produced those tokens and will bill for them whether or not we
     * forwarded them, and only `ok` rows are counted as spend.
     *
     * The usage is genuinely partial — whatever the model generated after the
     * cut was never reported to us — so this understates the call. It
     * understates rather than invents, which is the right direction for a
     * figure that has to reconcile with an invoice, and the violation on the
     * row says why the number is short.
     */
    ...(gateBlock !== undefined
      ? { statusCode: 403, errorMessage: gateBlock.reason }
      : {
          outcome: untrustworthy ? ("error" as const) : ("ok" as const),
          ...(untrustworthy ? { priced: false, errorMessage: reason } : {}),
        }),
  });
}
