import { randomUUID } from "node:crypto";
import {
  applyRate,
  applyRateTo,
  describeReasoning,
  estimateSaving,
  adjustmentRulesFor,
  ANY_ANSWER,
  type AnswerCheck,
  answerOf,
  type AnswerSpec,
  applyAdjustments,
  checkAnswer,
  costOfOpen,
  deriveMasterKey,
  evaluatePolicies,
  findModelPrice,
  isOpenModel,
  labelTask,
  parseOpenModel,
  readableText,
  substitutionAllowed,
  type PricedUsage,
  type PriceModifiers,
  type StreamTranslator,
  type TokenUsage,
  type WireFormat,
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
  AlertsRepository,
  Analytics,
  API_KEY_PREFIX,
  type CallRecord,
  CostGridRepository,
  destinationOf,
  EndpointsRepository,
  type Db,
  AgentsRepository,
  type ImportsRepository,
  KeyFactsRepository,
  notReadyReason,
  OUTCOME_SIGNALS,
  OutcomeSettingsRepository,
  QualityRepository,
  inCandidateArm,
  TrialsRepository,
  RunOutcomes,
  SourcesRepository,
  trailingWindow,
} from "@costgrid/db";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { type AlertNotice, Alerter, decisionAlerts, RunawayWatch } from "./alerts.js";
import { registerApi } from "./api.js";
import { Metrics, registerMetrics } from "./metrics.js";
import { ReadPool } from "./read-pool.js";
import { VERSION } from "./version.js";

/**
 * Ours, not `x-request-id`: providers send their own `x-request-id`, which the
 * proxy passes through because their support desk asks for it.
 */
export const REQUEST_ID_HEADER = "x-costgrid-request-id";
import { readCookie, registerConsole, sameOrigin, SESSION_COOKIE } from "./console.js";
import { registerAdvice } from "./console-advice.js";
import { registerAgents } from "./console-agents.js";
import { registerOutcomes } from "./console-outcomes.js";
import { registerQuality } from "./console-quality.js";
import { registerTrials } from "./console-trials.js";
import { registerEndpoints } from "./console-endpoints.js";
import { registerKeySafety } from "./console-key-safety.js";
import { registerControl } from "./console-control.js";
import { KeyControl } from "./key-control.js";
import { logSerializers } from "./log-safety.js";
import { registerConnect } from "./console-connect.js";
import { registerData } from "./console-data.js";
import { registerImport } from "./console-import.js";
import { registerLimits } from "./console-limits.js";
import { registerResults } from "./console-results.js";
import { registerSecurity } from "./console-security.js";
import { registerSetup } from "./console-setup.js";
import type { GatewayConfig } from "./config.js";
import { registerDashboard } from "./dashboard.js";
import { formatOf, requestFor, responseFor, streamFor, targetAdapterFor, upstreamModel } from "./cross-route.js";
import { guardedFetch } from "./outbound-guard.js";
import type { ModelLabeller } from "./task-labeller.js";
import { registerPredict } from "./predict-api.js";
import { gradeJob, SpotCheckMemory } from "./grading.js";
import { RoutingCache } from "./routing-cache.js";
import { type DeferredJobs, registerDeferred } from "./deferred.js";
import { ADAPTERS, adapterFor, type ProviderAdapter, type StreamUsageCollector } from "./providers/index.js";
import { RateLimiter } from "./ratelimit.js";
import { registerSecurityHeaders } from "./security-headers.js";
import type { SecretStore } from "./secret-store.js";
import { TASK_HEADER, TaskIdentifier } from "./task-identity.js";

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
  /**
   * The open database, for the console screens that read it directly: what
   * changed, advice, anchors, backup. Every other route goes through a
   * repository built on the same handle.
   */
  readonly db: Db;
  readonly repository: CostGridRepository;
  readonly analytics: Analytics;
  /** Required in hosted mode; absent in self-hosted, where there are no accounts. */
  readonly accounts?: AccountsRepository | undefined;
  readonly imports: ImportsRepository;
  /** Overridable for tests, which must never reach a real provider. */
  readonly fetchImpl?: typeof fetch;
  /** Where alerts are recorded. Absent, nothing alerts, which is how most tests run. */
  readonly alerts?: AlertsRepository | undefined;
  /** The desktop app's hook for showing a notification on this computer. */
  readonly onAlert?: ((notice: AlertNotice) => void) | undefined;
  /** Where admin keys are kept: the desktop app's keychain. Absent, a key is used once. */
  readonly secretStore?: SecretStore | undefined;
  /** Refines each call's task label after the answer (task-labeller.ts). Absent, labels come from signals alone. */
  readonly labeller?: ModelLabeller | undefined;
  /** The key for one-way codes of a job's first message (`fingerprint-key.ts`). Absent, only the task header works. */
  readonly fingerprintKey?: Uint8Array | undefined;
}

/** Each server's alerter, for the jobs `start.ts` runs beside it. */
const ALERTERS = new WeakMap<FastifyInstance, Alerter>();

/** The alerter a server raises alerts through; undefined when it was built without an alert store. */
export function alerterOf(app: FastifyInstance): Alerter | undefined {
  return ALERTERS.get(app);
}

const READS = new WeakMap<FastifyInstance, ReadPool>();

/** Each server's read pool, so the jobs in `start.ts` read off the request thread too. */
export function readsOf(app: FastifyInstance): ReadPool | undefined {
  return READS.get(app);
}

const DEFERRED = new WeakMap<FastifyInstance, DeferredJobs>();
const SPOT_CHECKS = new WeakMap<FastifyInstance, SpotCheckMemory>();
const ROUTING = new WeakMap<FastifyInstance, RoutingCache>();

/** Each server's routing cache, so a rebuild or a settings change can refresh it. */
export function routingCacheOf(app: FastifyInstance): RoutingCache | undefined {
  return ROUTING.get(app);
}

/** Each server's in-memory graded pairs, for the spot-check screen. */
export function spotChecksOf(app: FastifyInstance): SpotCheckMemory | undefined {
  return SPOT_CHECKS.get(app);
}

/** Each server's deferred jobs, so `start.ts` can check and price batches. */
export function deferredOf(app: FastifyInstance): DeferredJobs | undefined {
  return DEFERRED.get(app);
}

const METRICS = new WeakMap<FastifyInstance, Metrics>();

/** Each server's metrics, so the jobs in `start.ts` can count their failures. */
export function metricsOf(app: FastifyInstance): Metrics | undefined {
  return METRICS.get(app);
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
  // The Anthropic SDK sends its `api_key` as x-api-key, so that is where a
  // CostGrid key lands when someone writes Anthropic(api_key="cg_live_..."). It
  // counts only with the CostGrid prefix: "unused" and real provider keys keep
  // behaving as before. It is never forwarded, since upstream headers are
  // built from the stored credential and an allowlist.
  const sdkKey = headerValue(request, "x-api-key");
  const presented =
    headerValue(request, KEY_HEADER) ??
    headerValue(request, "authorization")?.replace(/^Bearer\s+/i, "") ??
    (sdkKey?.startsWith(API_KEY_PREFIX) === true ? sdkKey : undefined);

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

  // A write by cookie (the dashboard's policy toggle, an outcome) is held to
  // the console's rules: sent from our own pages, and by an owner.
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (!sameOrigin(request) || chosen.role !== "owner") return undefined;
  }

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
  // Answer specs and the decision log. Tests built without a database go without both.
  const quality = deps.db === undefined ? undefined : new QualityRepository(deps.db);
  const trials = deps.db === undefined ? undefined : new TrialsRepository(deps.db);
  // Per-request routing and cheap-first, read from memory on the request path.
  const routingCache = deps.db === undefined ? undefined : new RoutingCache(deps.db);
  // Graded pairs for the owner's spot checks, in memory only (grading.ts).
  const spotChecks = new SpotCheckMemory();
  // Open-model endpoints and each agent's opt-ins (cross-route.ts).
  const endpoints =
    deps.db === undefined
      ? undefined
      : new EndpointsRepository(deps.db, config.masterKeySecret === undefined ? undefined : deriveMasterKey(config.masterKeySecret));

  /**
   * May this agent's call go to `model` on another provider or an endpoint?
   * Only to a destination the agent opted in to, and only to a model CostGrid
   * can price: a routed call must never meter as free.
   */
  function crossAllowed(tenantId: string, agentId: string, model: string): boolean {
    if (endpoints === undefined) return false;
    const destination = destinationOf(model, findModelPrice(model)?.provider);
    if (destination === undefined || !endpoints.destinations(tenantId, agentId).includes(destination)) return false;
    return isOpenModel(model) ? endpoints.priceOf(tenantId, model) !== undefined : findModelPrice(model) !== undefined;
  }

  /** Where to send a call for `model` on `target`, with what key; undefined without one. */
  function resolveTarget(target: ProviderAdapter, tenantId: string, model: string): { apiKey: string; baseUrl: string } | undefined {
    if (target.id !== "open") return resolveUpstream(target, tenantId);
    const open = parseOpenModel(model);
    const found = open === undefined ? undefined : endpoints?.reveal(tenantId, open.endpoint);
    if (found === undefined) return undefined;
    // The base URL ends in the API's version; the path is relative to it.
    return { apiKey: found.apiKey ?? "", baseUrl: found.baseUrl.endsWith("/") ? found.baseUrl : `${found.baseUrl}/` };
  }

  /**
   * One extra call made by CostGrid itself, for side-by-side grading: buffered,
   * recorded as the agent's grading call so its cost shows in the agent's
   * costs, and answered as text. Undefined when it could not be made.
   */
  async function callModel(
    who: { tenantId: string; agentId: string; department: string },
    model: string,
    format: WireFormat,
    body: unknown,
  ): Promise<string | undefined> {
    const from = adapterFor(format === "openai" ? "openai" : "anthropic");
    const to = targetAdapterFor(model, from);
    const translated = requestFor(from, to, { ...(body as object), stream: false }, model);
    const credential = translated.ok ? resolveTarget(to, who.tenantId, model) : undefined;
    if (!translated.ok || credential === undefined) return undefined;
    const bytes = JSON.stringify(translated.body);
    const url = new URL(to.upstreamPath(upstreamModel(model), false), credential.baseUrl);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(await to.authHeaders(credential.apiKey, { method: "POST", url, body: bytes })),
      ...(to.id === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
    };
    const started = Date.now();
    const send = to.id === "open" && config.hosted ? guardedFetch(doFetch) : doFetch;
    const response = await send(url, { method: "POST", headers, body: bytes, signal: AbortSignal.timeout(config.upstreamTimeoutMs) });
    const payload: unknown = await response.json().catch(() => undefined);
    const parsed = response.ok ? to.parseBufferedResponse(payload) : undefined;
    const usage = parsed?.usage ?? ZERO_USAGE;
    const modifiers = parsed?.modifiers ?? {};
    const priced = priceCall(who.tenantId, model, usage, modifiers);
    const rate = repository.rateOverride(who.tenantId, to.id);
    repository.recordCall({
      id: randomUUID(),
      tenantId: who.tenantId,
      agentId: who.agentId,
      department: who.department,
      provider: to.id,
      model,
      startedAt: started,
      durationMs: Date.now() - started,
      streamed: false,
      usage,
      cost: applyRate(priced.cost, rate),
      costList: priced.cost,
      priced: parsed?.usage !== undefined && priced.priced,
      modifiers,
      outcome: response.ok ? "ok" : "error",
      statusCode: response.status,
      purpose: "grading",
    });
    return response.ok ? answerOf(payload).text : undefined;
  }

  /** The price of a call: the catalog's, or for an open model the owner's for that endpoint. */
  function priceCall(tenantId: string, model: string, usage: TokenUsage, modifiers: PriceModifiers): PricedUsage {
    if (!isOpenModel(model)) return priceUsage(model, usage, modifiers);
    const price = endpoints?.priceOf(tenantId, model);
    return price === undefined
      ? { usage, cost: ZERO_COST, price: undefined, priced: false, modifiers }
      : { usage, cost: costOfOpen(usage, price), price: undefined, priced: true, modifiers };
  }
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
    logger: {
      level: config.logLevel,
      ...(config.logFile === undefined ? {} : { file: config.logFile }),
      // An SSO callback's query string holds a one-time code; see log-safety.ts.
      serializers: logSerializers,
    },
    // A large context window means a large request body; the default 1MB cap
    // would reject legitimate long-document calls.
    bodyLimit: 64 * 1024 * 1024,
    // Off unless configured: see GatewayConfig.trustProxy.
    trustProxy: config.trustProxy ?? false,
    // Fastify turns Node's slow-client guard off; this puts it back. A client
    // gets five minutes to finish *sending* its request (a 64MB body on a
    // slow link included). How long the answer takes is not limited here:
    // that is upstreamTimeoutMs, and a long stream is legitimate.
    requestTimeout: 5 * 60 * 1000,
    // Our own id for each request, echoed as x-costgrid-request-id and on
    // every log line, so a customer's report can be found in the log. A
    // caller's own id is kept when it is a sane token; anything else is
    // replaced rather than written into the log.
    requestIdHeader: false,
    genReqId: (request) => {
      const theirs = request.headers["x-costgrid-request-id"];
      return typeof theirs === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(theirs) ? theirs : randomUUID();
    },
  });
  registerSecurityHeaders(app, config);
  const metrics = new Metrics();
  METRICS.set(app, metrics);
  registerMetrics(app, metrics, { token: config.metricsToken, hosted: config.hosted });
  app.addHook("onRequest", async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  const alerter =
    deps.alerts === undefined
      ? undefined
      : new Alerter({
          alerts: deps.alerts,
          log: app.log,
          fetchImpl: deps.fetchImpl,
          envWebhookUrl: config.alertWebhookUrl,
          onAlert: deps.onAlert,
          guardTenantWebhooks: config.hosted && deps.fetchImpl === undefined,
        });
  if (alerter !== undefined) ALERTERS.set(app, alerter);
  const runaway = new RunawayWatch(deps.db);
  const sources = new SourcesRepository(deps.db);
  const outcomeSettings = new OutcomeSettingsRepository(deps.db);
  const tasks = new TaskIdentifier({
    key: deps.fingerprintKey,
    enabled: (tenantId) => outcomeSettings.fingerprintEnabled(tenantId),
  });

  /*
   * Metering that can fail without taking the request with it.
   *
   * The asymmetry here is the whole point, and getting it backwards is a
   * correctness bug rather than a rough edge. **Deciding** whether a call may
   * proceed is fail-closed: if policy evaluation throws, the request dies and
   * nothing reaches the provider, which is what an enforcement product must
   * do. **Recording** what happened is not. By the time anything is recorded
   * the provider has already run the call and will bill for it, so refusing to
   * hand the customer the answer they have just paid for adds a second failure
   * to the first.
   *
   * Before this existed, a full disk or a locked database threw out of the
   * handler and the caller got a 500 on a call that succeeded upstream. They
   * were charged for tokens they never saw, and a retry charged them again.
   *
   * Losing a row is still serious: it is money that will appear on the
   * provider's invoice and not in any CostGrid figure. So the failure is
   * counted and surfaced on /health rather than only logged, because a line in
   * a log nobody reads is the same as no line at all.
   *
   * There is deliberately no dead-letter file. The most likely reason a write
   * fails is that the disk is full or read only, and a fallback that writes to
   * that same disk fails for the same reason while looking like a safety net.
   */
  /** Proxied calls in progress, per tenant: see maxConcurrentPerTenant. */
  const inFlight = new Map<string, number>();
  let meteringFailures = 0;
  let lastMeteringFailure: { at: number; reason: string } | undefined;

  function meter(what: string, write: () => void): void {
    try {
      write();
    } catch (error) {
      meteringFailures++;
      metrics.meteringFailures.inc();
      const reason = error instanceof Error ? error.message : String(error);
      lastMeteringFailure = { at: Date.now(), reason };
      app.log.error(
        { err: error, what, meteringFailures },
        "METERING WRITE FAILED: this call is missing from CostGrid's figures but will " +
          "still appear on the provider's invoice. The caller was served normally.",
      );
    }
  }

  app.get("/health", async () => ({
    // Still "ok", and still a 200. A metering failure must not pull the
    // gateway out of a load balancer: that would turn losing a row into
    // refusing every call, which is the trade this whole guard exists to
    // avoid. Monitoring should alarm on meteringFailures, not on status.
    status: "ok",
    version: VERSION,
    hosted: config.hosted,
    /** Rows that could not be written. Non-zero means figures are understated. */
    meteringFailures,
    // /health is unauthenticated, so a hosted gateway shows when, not the raw
    // error (which can name tables); the reason is in the operator's log.
    ...(lastMeteringFailure
      ? { lastMeteringFailure: config.hosted ? { at: lastMeteringFailure.at } : lastMeteringFailure }
      : {}),
    providers: ADAPTERS.filter((a) => config.hosted || config.providerKeys[a.id] !== undefined).map(
      (a) => ({ id: a.id, path: a.path }),
    ),
  }));

  // Separate from /health on purpose: /health says the process is alive (a
  // restart won't help if it isn't), /ready says it can take traffic now (a
  // load balancer should wait). A schema behind this build is "not ready",
  // never "dead".
  app.get("/ready", async (_request, reply) => {
    const reason = notReadyReason(deps.db);
    if (reason !== undefined) return reply.code(503).send({ ready: false, reason });
    return { ready: true, version: VERSION };
  });

  // The dashboard API and the proxy share a process so a self-hosted deploy is
  // one command. In a multi-tenant hosted setting these would be separate
  // services — reporting load must never contend with the metering path.
  // The console's slow reports run on their own thread with a read-only
  // connection, so they never hold up forwarding a call (read-tasks.ts).
  // Some tests build a server around repositories alone, with no database
  // handle; their reports run in-process as before.
  const reads =
    deps.db === undefined ? undefined : new ReadPool(deps.db, config.readWorker === true ? config.databasePath : undefined);
  if (reads !== undefined) READS.set(app, reads);
  SPOT_CHECKS.set(app, spotChecks);
  if (routingCache !== undefined) ROUTING.set(app, routingCache);
  app.addHook("onClose", async () => {
    await reads?.close();
  });

  registerApi(app, {
    reads,
    repository,
    analytics,
    imports,
    sources,
    runOutcomes: new RunOutcomes(deps.db),
    // A session cookie is accepted here for reading; writes by cookie need an
    // owner and a same-origin request (see identifyBySession).
    tenantOf: (request) => identify(request, deps, true)?.tenantId,
  });
  if (config.hosted) {
    registerConsole(app, {
      config,
      accounts: accounts!,
      repository,
      analytics,
      fetchImpl: deps.fetchImpl,
    });
    registerImport(app, { accounts: accounts!, imports, sources, fetchImpl: deps.fetchImpl });
    registerConnect(app, {
      accounts: accounts!,
      imports,
      sources,
      keyFacts: new KeyFactsRepository(deps.db),
      secretStore: deps.secretStore,
      fetchImpl: deps.fetchImpl,
    });
    registerKeySafety(app, { db: deps.db, accounts: accounts! });
    registerAgents(app, { accounts: accounts!, agents: new AgentsRepository(deps.db) });
    registerOutcomes(app, {
      reads,
      db: deps.db,
      accounts: accounts!,
      settings: outcomeSettings,
      fingerprintAvailable: tasks.available,
    });
    registerSecurity(app, { config, accounts: accounts!, fetchImpl: deps.fetchImpl });
    registerSetup(app, { config, accounts: accounts! });
    registerAdvice(app, { db: deps.db, accounts: accounts!, repository });
    registerQuality(app, { db: deps.db, accounts: accounts! });
    registerTrials(app, { db: deps.db, accounts: accounts!, spotChecks, invalidateRouting: () => routingCache?.invalidate() });
    registerEndpoints(app, {
      db: deps.db,
      accounts: accounts!,
      hosted: config.hosted,
      masterKey: config.masterKeySecret === undefined ? undefined : deriveMasterKey(config.masterKeySecret),
    });
    registerData(app, {
      config,
      db: deps.db,
      accounts: accounts!,
      repository,
      secretStore: deps.secretStore,
      fetchImpl: deps.fetchImpl,
    });
    // Without a store passed in (tests), alerts are still recorded and
    // listed; only an address cannot be saved, for want of a key.
    const alertStore = deps.alerts ?? new AlertsRepository(deps.db);
    registerLimits(app, { db: deps.db, accounts: accounts!, repository, alerts: alertStore, alerter, reads });
    registerControl(app, {
      db: deps.db,
      accounts: accounts!,
      canStoreKeys: deps.secretStore !== undefined,
      keyControl: new KeyControl({ db: deps.db, audit: accounts!.audit, secretStore: deps.secretStore, alerter, fetchImpl: deps.fetchImpl }),
    });
    registerResults(app, {
      db: deps.db,
      accounts: accounts!,
      repository,
      analytics,
      imports,
      alerts: alertStore,
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

      // --- Calls in flight at once, hosted only ----------------------------
      // The per-minute limit counts arrivals; a long stream holds a socket and
      // an upstream connection for minutes, so one organisation could still
      // hold most of the server. Released when the answer ends or the caller
      // goes away, whichever happens first.
      if (config.maxConcurrentPerTenant > 0) {
        const running = inFlight.get(caller.tenantId) ?? 0;
        if (running >= config.maxConcurrentPerTenant) {
          reply.header("retry-after", "1");
          return reply.code(429).send({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: `More than ${config.maxConcurrentPerTenant} calls in progress at once for this organisation. Retry when one finishes.`,
            },
          });
        }
        inFlight.set(caller.tenantId, running + 1);
        reply.raw.once("close", () => {
          const left = (inFlight.get(caller.tenantId) ?? 1) - 1;
          if (left <= 0) inFlight.delete(caller.tenantId);
          else inFlight.set(caller.tenantId, left);
        });
      }

      const upstreamCredential = resolveUpstream(adapter, caller.tenantId);
      // A call to an open model goes to its endpoint, so it needs no OpenAI key.
      const directOpen = adapter.id === "openai" && isOpenModel(adapter.modelOf(request.body));
      if (!upstreamCredential && !directOpen) {
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
      const reasoning = adapter.reasoningOf?.(request.body);
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
        ...(reasoning === undefined ? {} : { reasoning }),
        // Across providers only to a destination this agent opted in to, and a model CostGrid can price.
        canRouteTo: (model: string) => crossAllowed(caller.tenantId, caller.agentId, model),
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

      /*
       * Tell someone, when a limit fired or a run is going wrong.
       *
       * After the decision and unable to change it. Guarded as a whole: the
       * decision above is the part that must fail closed, and a notification
       * that cannot be raised must not turn into a refused call.
       */
      if (alerter !== undefined) {
        try {
          for (const alert of decisionAlerts(decision, policies, caller, runId, startedAt)) {
            alerter.raise(caller.tenantId, alert, startedAt);
          }
          if (runStats !== undefined && declaredRun !== undefined && decision.allowed) {
            const runawayAlert = runaway.check(
              caller.tenantId,
              caller.agentId,
              declaredRun,
              runStats.spend,
              startedAt,
            );
            if (runawayAlert !== undefined) alerter.raise(caller.tenantId, runawayAlert, startedAt);
          }
        } catch (error) {
          app.log.warn({ err: error }, "alert check failed; the call was not affected");
        }
      }

      // What kind of task this is, from signals, before forwarding. Never the words.
      const label = labelTask(formatOf(adapter.id), request.body);
      // Held in memory for the local model only, and only when there is one.
      const labelWords = deps.labeller === undefined ? undefined : readableText(request.body);

      /*
       * A trial (phase 5): a share of this agent's jobs goes to a candidate
       * model, the rest stays as asked, and both are tagged so they can be
       * judged side by side. The job's key decides, so all its calls land on
       * the same model. Only when no rule already chose a model, only for the
       * model the trial tests, never for a request marked critical, and only
       * to a candidate this agent may be sent to.
       */
      const taskIdentity = tasks.of(headerValue(request, TASK_HEADER), request.body, caller.tenantId);
      const jobKey = taskIdentity.taskKey ?? runId;
      const trial =
        decision.allowed && decision.route === undefined && trials !== undefined
          ? trials.runningFor(caller.tenantId, caller.agentId)
          : undefined;
      let trialTag: { trialId: string; trialArm: "candidate" | "baseline" } | undefined;
      let trialRoute: typeof decision.route;
      if (trial !== undefined && trial.baselineModel === requestedModel && headerValue(request, "x-costgrid-critical") !== "true") {
        const reachable =
          substitutionAllowed(requestedModel, trial.candidateModel) || crossAllowed(caller.tenantId, caller.agentId, trial.candidateModel);
        if (inCandidateArm(trial.id, jobKey, trial.shareMilli)) {
          if (reachable) {
            trialTag = { trialId: trial.id, trialArm: "candidate" };
            trialRoute = {
              policyId: trial.id,
              policyName: `trial ${trial.id}`,
              fromModel: requestedModel,
              toModel: trial.candidateModel,
              applied: true,
              fallback: false,
              reason: `trial ${trial.id}: testing ${trial.candidateModel} on ${trial.shareMilli / 10}% of jobs`,
            };
          }
        } else {
          trialTag = { trialId: trial.id, trialArm: "baseline" };
        }
      }

      /*
       * Per-request routing (phase 6, D17): the model the agent's own
       * evidence chose for this kind of task, from the routing table held in
       * memory. Only for agents that opted in after an approved trial, only
       * when no rule or trial chose already, and only to a reachable model.
       */
      const free = decision.allowed && decision.route === undefined && trialRoute === undefined && trialTag === undefined;
      const choice = free ? routingCache?.choice(caller.tenantId, caller.agentId, label.kind) : undefined;
      const reachable = (model: string) =>
        substitutionAllowed(requestedModel, model) || crossAllowed(caller.tenantId, caller.agentId, model);
      const perRequestRoute: typeof decision.route =
        choice !== undefined && choice.model !== requestedModel && reachable(choice.model)
          ? {
              policyId: "per-request",
              policyName: "per-request routing",
              fromModel: requestedModel,
              toModel: choice.model,
              applied: true,
              fallback: false,
              reason:
                `per-request routing for ${label.kind}: ${Math.round(choice.predictedQualityMilli / 10)}% quality predicted, ` +
                `${Math.round(choice.confidenceMilli / 10)}% sure, from ${choice.evidenceJobs} judged jobs`,
            }
          : undefined;

      /*
       * Cheap first, then step up (phase 6, D15): a buffered request goes to
       * the agent's cheap model first, and to the model it asked for only if
       * that answer clearly fails. Same provider only; never a stream.
       */
      const cheap = free && perRequestRoute === undefined && !streaming ? routingCache?.stepUp(caller.tenantId, caller.agentId) : undefined;
      const stepRoute: typeof decision.route =
        cheap !== undefined && cheap !== requestedModel && targetAdapterFor(cheap, adapter) === adapter && substitutionAllowed(requestedModel, cheap)
          ? {
              policyId: "cheap-first",
              policyName: "cheap first",
              fromModel: requestedModel,
              toModel: cheap,
              applied: true,
              fallback: false,
              reason: `cheap first: ${cheap}, stepping up to ${requestedModel} if the answer clearly fails`,
            }
          : undefined;
      let stepped: string | undefined;
      let stepId: string | undefined;

      const baseRecord = {
        ...(trialTag ?? {}),
        taskKind: label.kind,
        taskSize: label.size,
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
        reasoningRequested: describeReasoning(reasoning),
        // Which job this is part of: the developer's id, or a one-way code of its first message.
        ...taskIdentity,
      };

      if (!decision.allowed) {
        const blocked = decision.blockedBy!;

        // Nothing was spent here, and the refusal below happens either way:
        // enforcement lives in the return, not in the write. Wrapping it means
        // a failing disk cannot turn a clean 403 into a confusing 500.
        meter("blocked-call", () => {
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
        });

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

      /*
       * Apply a route rule, if one matched and is not a dry run.
       *
       * This is the only place CostGrid changes what the customer asked for,
       * so it happens once, explicitly, on a copy of the body. `requestedModel`
       * is kept for the record: without it a rerouted call is indistinguishable
       * from one that simply used a cheap model, and the saving is unprovable.
       *
       * The target may be on another provider or an open-model endpoint
       * (cross-route.ts): the body is then translated, and a call that cannot
       * be translated faithfully, or whose target has no credential, stays on
       * the model it asked for, with the reason in the decision log.
       */
      let route = decision.route ?? trialRoute ?? perRequestRoute ?? stepRoute;
      let notRouted: { model: string; reason: string } | undefined;
      let target = adapter;
      let outgoingBody: unknown = request.body;
      let upstreamTarget = upstreamCredential;
      const targetModel = route?.applied === true ? route.toModel : requestedModel;
      if (targetModel !== requestedModel || directOpen) {
        const candidate = targetAdapterFor(targetModel, adapter);
        const body = requestFor(adapter, candidate, request.body, targetModel);
        const credential = body.ok ? resolveTarget(candidate, caller.tenantId, targetModel) : undefined;
        if (body.ok && credential !== undefined) {
          target = candidate;
          outgoingBody = body.body;
          upstreamTarget = credential;
        } else if (directOpen) {
          return reply.code(400).send({
            type: "error",
            error: {
              type: "provider_not_configured",
              message: `No open-model endpoint is set up for ${targetModel}. Add it in Settings, under open models.`,
            },
          });
        } else {
          notRouted = {
            model: targetModel,
            reason: body.ok ? `no credential for ${candidate.id} to send it with` : body.reason,
          };
          reply.header("x-costgrid-not-routed", headerSafe(`${targetModel}: ${notRouted.reason}`));
          route = undefined;
          // A job the candidate could not take is in neither arm.
          if (trialTag !== undefined) Object.assign(baseRecord, { trialId: undefined, trialArm: undefined });
        }
      }
      const { apiKey, baseUrl } = upstreamTarget!;

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

      /*
       * Adjustment rules: lower reasoning, cache breakpoints. They change how
       * the request is sent, never which model answers it, and run after
       * routing so they see the body that will actually go out. Most callers
       * have none in scope, and then nothing is copied.
       */
      const adjustRules = adjustmentRulesFor(policies, context);
      const adjusted =
        adjustRules.length === 0
          ? { body: outgoingBody, adjustments: [] }
          : applyAdjustments(
              adjustRules,
              formatOf(target.id),
              outgoingBody,
              upstreamModel(route?.applied === true ? route.toModel : requestedModel),
            );
      const madeChanges = adjusted.adjustments.filter((a) => a.applied).map((a) => a.change);
      if (madeChanges.length > 0) reply.header("x-costgrid-adjusted", headerSafe(madeChanges.join("; ")));

      // OpenAI omits usage from streams unless asked; without this every
      // streamed call would meter as zero.
      const prepared = config.injectUsageRequest
        ? target.prepareBody(adjusted.body)
        : { body: adjusted.body, injectedUsageRequest: false };

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
      const upstreamUrl = new URL(target.upstreamPath(upstreamModel(servedModel), streaming), baseUrl);

      /*
       * Authentication is resolved last, because two channels need the final
       * request to produce it: SigV4 signs the method, the path and the exact
       * body bytes, so anything that rewrites the body — routing, usage
       * injection — has to happen first or the signature will not verify.
       */
      const upstreamHeaders: Record<string, string> = {
        "content-type": "application/json",
        ...(await target.authHeaders(apiKey, {
          method: "POST",
          url: upstreamUrl,
          body: outgoingBytes,
        })),
      };
      // A caller's provider headers mean nothing to another provider, so they
      // go only where the call was addressed.
      if (target === adapter) {
        for (const name of adapter.forwardedRequestHeaders) {
          const value = headerValue(request, name);
          if (value !== undefined) upstreamHeaders[name] = value;
        }
      }
      if (target.id === "anthropic" && upstreamHeaders["anthropic-version"] === undefined) {
        upstreamHeaders["anthropic-version"] = "2023-06-01";
      }

      let upstream: Response;
      metrics.forwarded(target.id, reply.elapsedTime / 1000);
      // An open-model endpoint is an address the organisation typed in: hosted, it must be public.
      const send = target.id === "open" && config.hosted ? guardedFetch(doFetch) : doFetch;
      try {
        upstream = await send(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: outgoingBytes,
          signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        metrics.upstreamError(target.id, error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network");
        meter("upstream-error", () =>
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
          }),
        );
        return reply.code(502).send({
          type: "error",
          error: { type: "upstream_unreachable", message },
        });
      }

      if (upstream.status >= 500) metrics.upstreamError(target.id, "5xx");
      for (const name of target.forwardedResponseHeaders) {
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

      /*
       * The post-spend write, wrapped.
       *
       * Everything below this point runs after the provider has produced
       * tokens it will bill for, so nothing in here may be allowed to fail the
       * response. `streamThrough` is handed the wrapped version too, which is
       * why the streaming path needs no guard of its own.
       */
      const record = (over: RecordOverrides): void => {
        meter("call", () => recordUnsafe(over));
      };

      // What a good answer looks like for this agent, read once and only after the answer.
      let spec: AnswerSpec | undefined;
      const answerSpec = (): AnswerSpec => (spec ??= quality?.forAgent(caller.tenantId, caller.agentId).spec ?? ANY_ANSWER);
      const judgeBuffered = (stopReason: string | undefined, payload: unknown): { answerCheck?: AnswerCheck } => {
        const { text, refused } = answerOf(payload);
        const verdict = checkAnswer({ stopReason, text, refused }, answerSpec());
        return verdict === undefined ? {} : { answerCheck: verdict };
      };

      /*
       * The decision log: every choice about where or how this call was sent,
       * with its reason. Written with the call, after the answer, and guarded
       * on its own so a failure here cannot cost the call row.
       */
      const recordDecisions = (callRowId: string, servedAs: string): void => {
        if (quality === undefined || (route === undefined && notRouted === undefined && adjusted.adjustments.length === 0)) return;
        try {
          if (notRouted !== undefined) {
            quality.recordDecision({
              tenantId: caller.tenantId,
              callId: callRowId,
              agentId: caller.agentId,
              decidedAt: startedAt,
              kind: "not-routed",
              requestedModel,
              chosenModel: servedAs,
              applied: true,
              ...(decision.route !== undefined ? { policyId: decision.route.policyId } : {}),
              reason: `kept on ${requestedModel}: ${notRouted.reason}`,
              rejected: [{ model: notRouted.model, why: notRouted.reason }],
            });
          }
          if (stepped !== undefined) {
            quality.recordDecision({
              tenantId: caller.tenantId,
              callId: callRowId,
              agentId: caller.agentId,
              decidedAt: startedAt,
              kind: "route",
              requestedModel,
              chosenModel: servedAs,
              applied: true,
              policyId: "cheap-first",
              reason: `stepped up to ${requestedModel}: ${stepped}`,
              rejected: [{ model: stepRoute!.toModel, why: stepped }],
            });
            return;
          }
          if (route !== undefined) {
            quality.recordDecision({
              ...(route === perRequestRoute && choice !== undefined
                ? {
                    ...(choice.predictedCost !== null ? { predictedCost: choice.predictedCost } : {}),
                    predictedQualityMilli: choice.predictedQualityMilli,
                    confidenceMilli: choice.confidenceMilli,
                  }
                : {}),
              tenantId: caller.tenantId,
              callId: callRowId,
              agentId: caller.agentId,
              decidedAt: startedAt,
              kind: route.fallback ? "fallback" : "route",
              requestedModel: route.fromModel,
              chosenModel: route.applied ? servedAs : route.fromModel,
              applied: route.applied,
              policyId: route.policyId,
              reason: route.applied ? route.reason : `dry run: ${route.reason}`,
              rejected:
                route === perRequestRoute && choice !== undefined
                  ? [...choice.rejected]
                  : route.applied
                    ? [{ model: route.fromModel, why: `rule "${route.policyName}" sends this traffic elsewhere` }]
                    : [{ model: route.toModel, why: `rule "${route.policyName}" is a dry run` }],
            });
          }
          if (adjusted.adjustments.length > 0) {
            const made = adjusted.adjustments.filter((a) => a.applied);
            quality.recordDecision({
              tenantId: caller.tenantId,
              callId: callRowId,
              agentId: caller.agentId,
              decidedAt: startedAt,
              kind: "adjust",
              requestedModel: requestedModel,
              chosenModel: servedAs,
              applied: made.length > 0,
              policyId: (made[0] ?? adjusted.adjustments[0]!).policyId,
              reason: adjusted.adjustments
                .map((a) => `${a.applied ? "" : "dry run: "}${a.change} by "${a.policyName}"`)
                .join("; "),
            });
          }
        } catch (error) {
          app.log.warn({ err: error }, "the routing decision could not be logged; the call was recorded");
        }
      };

      const recordUnsafe = (over: RecordOverrides): void => {
        const usage = over.usage ?? ZERO_USAGE;
        const model = over.model ?? requestedModel;
        const modifiers = over.modifiers ?? {};
        const computed = priceCall(caller.tenantId, model, usage, modifiers);

        /*
         * The negotiated rate, applied here rather than at read time.
         *
         * Every budget, statement and analytic already reads `cost`, so
         * discounting once at the point of record means none of them can be
         * left behind reporting list prices. The catalog figure travels
         * alongside as `costList`, which is what makes the discount provable
         * instead of asserted.
         */
        const rate = rateFor(target.id);
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

        // A stream is judged on how it ended; its text was never held whole.
        const answerCheck =
          over.answerCheck ??
          ((over.outcome ?? "ok") === "ok" && streaming
            ? checkAnswer({ stopReason: over.stopReason, text: undefined }, answerSpec())
            : undefined);

        // `priced: false` means the cost could not be established — either the
        // model is uncatalogued, or the provider reported no usage. Both must
        // surface as unpriced rather than as free traffic.
        const priced = over.priced === false ? false : computed.priced;


        // `record` runs at most once per request, so reusing the id minted
        // above keeps a synthetic run_id pointing at a call that exists.
        const id = over.id ?? stepId ?? callId;
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
          ...(adjusted.adjustments.length > 0 ? { adjustments: adjusted.adjustments } : {}),
          ...(answerCheck !== undefined ? { answerCheck } : {}),
        } as CallRecord);
        recordDecisions(id, model);
        if (deps.labeller !== undefined && labelWords) {
          void deps.labeller
            .label(labelWords)
            .then((kind) => {
              if (kind !== label.kind) repository.relabelCall(caller.tenantId, id, kind);
            })
            .catch((error: unknown) => app.log.warn({ err: error }, "the local task label failed; the signals label stands"));
        }

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
            // Narrower than the outer guard on purpose: a bad tool name should
            // not cost us the call row, which is the one that carries the money.
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
        return streamThrough(target, reply, upstream, record, app.log, toolGuard, {
          translator: streamFor(adapter, target, servedModel, request.body),
          ...(target.id === "open" ? { model: servedModel } : {}),
        });
      }

      // --- Buffered response ------------------------------------------------
      const readPayload = (body: string): unknown => {
        try {
          return JSON.parse(body);
        } catch {
          return { type: "error", error: { type: "upstream_invalid_json", message: body.slice(0, 500) } };
        }
      };
      let payload = readPayload(await upstream.text());

      if (route !== undefined && route === stepRoute) {
        const first = upstream.ok ? target.parseBufferedResponse(payload) : undefined;
        const check = first === undefined ? undefined : judgeBuffered(first.stopReason, payload).answerCheck;
        if (!upstream.ok || (check !== undefined && check !== "pass")) {
          const why = upstream.ok ? `the cheap answer was ${check}` : `the cheap model failed with ${upstream.status}`;
          // The cheap call is recorded as it was, and counts.
          record({
            ...(first !== undefined
              ? {
                  usage: first.usage ?? ZERO_USAGE,
                  modifiers: first.modifiers,
                  ...(first.model !== undefined ? { model: first.model } : {}),
                  ...(first.stopReason !== undefined ? { stopReason: first.stopReason } : {}),
                  ...(check !== undefined ? { answerCheck: check } : {}),
                  outcome: "ok" as const,
                }
              : { outcome: "error" as const, errorMessage: `upstream ${upstream.status}` }),
          });
          reply.header("x-costgrid-stepped-up", headerSafe(`${route.toModel}->${requestedModel}`));
          // From here on the call is the step up: a fresh row, logged as one.
          stepped = why;
          route = undefined;
          stepId = randomUUID();
          const original = config.injectUsageRequest ? adapter.prepareBody(request.body).body : request.body;
          const bytes = JSON.stringify(original);
          const url = new URL(adapter.upstreamPath(requestedModel, false), upstreamCredential!.baseUrl);
          const headers: Record<string, string> = {
            "content-type": "application/json",
            ...(await adapter.authHeaders(upstreamCredential!.apiKey, { method: "POST", url, body: bytes })),
          };
          for (const name of adapter.forwardedRequestHeaders) {
            const value = headerValue(request, name);
            if (value !== undefined) headers[name] = value;
          }
          if (adapter.id === "anthropic" && headers["anthropic-version"] === undefined) headers["anthropic-version"] = "2023-06-01";
          upstream = await doFetch(url, { method: "POST", headers, body: bytes, signal: AbortSignal.timeout(config.upstreamTimeoutMs) });
          payload = readPayload(await upstream.text());
        }
      }

      if (!upstream.ok) {
        record({ outcome: "error", errorMessage: `upstream ${upstream.status}` });
        return reply.code(upstream.status).send(payload);
      }

      const parsed = target.parseBufferedResponse(payload);

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
        // An endpoint names its model its own way; the call is priced by the id CostGrid knows it by.
        ...(target.id === "open" ? { model: servedModel } : parsed.model !== undefined ? { model: parsed.model } : {}),
        usage: parsed.usage ?? ZERO_USAGE,
        reasoningTokens: parsed.reasoningTokens,
        modifiers: parsed.modifiers,
        ...(parsed.stopReason !== undefined ? { stopReason: parsed.stopReason } : {}),
        // Judged in memory; only the one-word result is kept.
        ...judgeBuffered(parsed.stopReason, payload),
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

      /*
       * Side-by-side grading, for a sampled trial job whose organisation opted
       * in: after the caller has its answer, never before. A step that asks
       * for a tool is not an answer to grade.
       */
      if (
        trial !== undefined &&
        trialTag !== undefined &&
        trials !== undefined &&
        (adapter.id === "anthropic" || adapter.id === "openai") &&
        parsed.stopReason !== "tool_use" &&
        parsed.stopReason !== "tool_calls"
      ) {
        const grading = trials.grading(caller.tenantId);
        if (grading.enabled && inCandidateArm(`${trial.id}:grade`, jobKey, grading.shareMilli)) {
          const answer = answerOf(payload).text;
          if (answer !== undefined) {
            void gradeJob(
              {
                tenantId: caller.tenantId,
                trialId: trial.id,
                callId,
                runId,
                arm: trialTag.trialArm,
                format: formatOf(adapter.id),
                request: request.body,
                task: readableText(request.body),
                answer,
                otherModel: trialTag.trialArm === "candidate" ? trial.baselineModel : trial.candidateModel,
              },
              {
                call: (model, format, body) => callModel(caller, model, format, body),
                trials,
                memory: spotChecks,
                holdAnswers: grading.spotChecks,
              },
            ).catch((error: unknown) => app.log.warn({ err: error }, "grading a trial job failed; it was skipped"));
          }
        }
      }

      // In the format the caller spoke, whichever provider answered.
      return reply.code(upstream.status).send(responseFor(adapter, target, payload, servedModel));
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

    /*
     * How good the answer was, where the customer's software knows: a score
     * from 0 to 1, and what a person did with it. Both optional, both checked
     * here, at the boundary, so nothing else ever sees a malformed one.
     */
    const rawQuality = body["quality"];
    if (rawQuality !== undefined && (typeof rawQuality !== "number" || !(rawQuality >= 0 && rawQuality <= 1))) {
      return reply.code(400).send({ error: "quality must be a number from 0 to 1" });
    }
    const rawSignal = body["signal"];
    if (rawSignal !== undefined && !(OUTCOME_SIGNALS as readonly unknown[]).includes(rawSignal)) {
      return reply.code(400).send({ error: `signal must be one of ${OUTCOME_SIGNALS.join(", ")}` });
    }

    repository.recordOutcome({
      tenantId: caller.tenantId,
      runId,
      succeeded: body["success"],
      label,
      ...(typeof rawQuality === "number" ? { qualityMilli: Math.round(rawQuality * 1000) } : {}),
      ...(typeof rawSignal === "string" ? { signal: rawSignal } : {}),
      at: Date.now(),
    });

    return reply.code(202).send({ recorded: true, run_id: runId });
  });

  // "Which model is best for this agent or this sample task?" (predict-api.ts).
  registerPredict(app, { db: deps.db, reads, identify: (request) => identify(request, deps, true) });

  // Work that can wait, at the batch rate (deferred.ts). The proxy path above is unchanged.
  DEFERRED.set(
    app,
    registerDeferred(app, {
      db: deps.db,
      repository,
      identify: (request, allowSession) => identify(request, deps, allowSession),
      resolveUpstream,
      fetchImpl: doFetch,
      log: app.log,
    }),
  );

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
  /**
   * `translator` rewrites the stream into the caller's format when another
   * provider answered (cross-route.ts); metering still reads the original.
   * `model` is the id to record the call under when the provider names it
   * differently (an open-model endpoint).
   */
  options: { translator?: StreamTranslator | undefined; model?: string } = {},
): Promise<void> {
  const collector: StreamUsageCollector = adapter.createStreamCollector();
  const decoder = new TextDecoder();
  const { translator } = options;
  /** Send bytes on, translated when needed, respecting backpressure. */
  const forward = async (value: Uint8Array, text: string | undefined): Promise<void> => {
    const out = translator === undefined ? Buffer.from(value) : translator.push(text ?? "");
    if (out.length === 0) return;
    if (!reply.raw.write(out)) await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
  };

  reply.raw.writeHead(upstream.status, {
    [REQUEST_ID_HEADER]: reply.request.id,
    "content-type": translator !== undefined ? "text/event-stream" : (upstream.headers.get("content-type") ?? "text/event-stream"),
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
      if (toolGuard !== undefined || translator !== undefined) {
        const text = decoder.decode(value, { stream: true });
        collector.feed(text);

        const seen = collector.invokedTools;
        for (; toolGuard !== undefined && checkedTools < seen.length; checkedTools += 1) {
          const violation = toolGuard.check(seen[checkedTools]!);
          if (violation === undefined) continue;
          gated.push(violation);
          if (violation.action === "block") gateBlock = violation;
        }

        if (gateBlock !== undefined) break;

        await forward(value, text);
        continue;
      }

      if (!reply.raw.write(Buffer.from(value))) {
        // Respect backpressure rather than buffering the whole stream in memory.
        await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
      }
      collector.feed(decoder.decode(value, { stream: true }));
    }
    collector.end();
    if (translator !== undefined && gateBlock === undefined) reply.raw.write(translator.end());
  } catch (error) {
    aborted = true;
    log.warn({ err: error }, "stream interrupted; usage may be partial");
  } finally {
    if (gateBlock !== undefined) {
      // A stream that simply stops leaves the caller debugging a network fault
      // that never happened.
      // In the provider's own format, which is the caller's unless the stream was translated.
      const event = translator !== undefined ? undefined : adapter.streamError?.(
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
    ...(options.model !== undefined ? { model: options.model } : collector.model !== undefined ? { model: collector.model } : {}),
    usage: collector.usage,
    reasoningTokens: collector.reasoningTokens,
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
