import {
  analyzeRouting,
  blendedCost,
  CATALOG_PROVENANCE,
  CATALOG_STALE_AFTER_DAYS,
  CATALOG_VERIFIED_AT,
  catalogAgeDays,
  costCurve,
  DEFAULT_ASSUMPTIONS,
  isCatalogStale,
  listModelPrices,
  type Nanodollars,
  toUsdNumber,
  toUsdString,
  usd,
} from "@costgrid/core";
import {
  type Analytics,
  type CostGridRepository,
  type ImportsRepository,
  type TimeRange,
  trailingWindow,
} from "@costgrid/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * The read/write API behind the dashboard.
 *
 * Money crosses the wire as a decimal *string* (`"12.345678"`), never a JSON
 * number. JSON has no integer type wide enough for nanodollars and its number
 * type is a double — serialising money as a float would reintroduce exactly
 * the drift the bigint representation exists to prevent. A `…Usd` suffix on a
 * field name means "decimal string, safe to display, do not do arithmetic on
 * it in the browser".
 */

export interface ApiDeps {
  readonly repository: CostGridRepository;
  readonly analytics: Analytics;
  readonly imports: ImportsRepository;
  /** Resolves the caller's tenant, or undefined when unauthenticated. */
  readonly tenantOf: (request: FastifyRequest) => string | undefined;
}

function money(value: Nanodollars): string {
  return toUsdString(value, 6);
}

function parseDays(request: FastifyRequest): number {
  const raw = (request.query as Record<string, unknown> | undefined)?.["days"];
  if (raw === undefined) return 30;

  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw Object.assign(new Error("days must be an integer between 1 and 3650"), {
      statusCode: 400,
    });
  }
  return days;
}

function rangeFor(days: number): TimeRange {
  return trailingWindow(days);
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { analytics, imports, repository, tenantOf } = deps;

  // Every /api route is tenant-scoped; resolving it once here means no
  // individual handler can forget to filter by tenant.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;

    const tenantId = tenantOf(request);
    if (tenantId === undefined) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    (request as FastifyRequest & { tenantId: string }).tenantId = tenantId;
  });

  const tenant = (request: FastifyRequest): string =>
    (request as FastifyRequest & { tenantId: string }).tenantId;

  app.get("/api/overview", async (request) => {
    const days = parseDays(request);
    const range = rangeFor(days);
    const tenantId = tenant(request);

    const summary = analytics.summary(tenantId, range);
    const share = analytics.substitutionShare(tenantId, range);
    const routing = analyzeRouting(share);
    const spentDollars = toUsdNumber(summary.totalCost);

    return {
      days,
      range,
      catalogStale: isCatalogStale(),
      catalogAgeDays: catalogAgeDays(),
      // Lets the dashboard offer imported history when nothing is metered yet,
      // instead of showing a prospect an empty screen.
      hasImportedHistory: imports.hasImports(tenantId),
      totalCostUsd: money(summary.totalCost),
      // A 30-day projection from the observed daily average. Labelled a
      // projection because with three days of data it is barely one.
      runRate30dUsd: (spentDollars / days) * 30,
      calls: summary.calls,
      blockedCalls: summary.blockedCalls,
      erroredCalls: summary.erroredCalls,
      unpricedCalls: summary.unpricedCalls,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cacheReadTokens: summary.cacheReadTokens,
      cacheHitRatio: summary.cacheHitRatio,
      substitutionShare: share,
      routing: {
        optimalShare: routing.optimalShare,
        savingFraction: routing.savingFraction,
        projectedSavingUsd: spentDollars * routing.savingFraction,
      },
    };
  });

  /**
   * Historical usage imported from a provider's admin API.
   *
   * Returned on its own route, never merged into /api/overview. These are the
   * provider's daily aggregates, not calls we watched: lower fidelity, no
   * per-agent attribution, and nothing we can enforce against. Presenting them
   * as if they were metered would be the most damaging kind of convenience.
   */
  app.get("/api/history", async (request) => {
    const days = parseDays(request);
    const range = rangeFor(days);
    const tenantId = tenant(request);

    const summary = imports.summary(tenantId, range);
    // When the provider told us what it charged, that beats our list price —
    // it already includes whatever rate they negotiated.
    const effective = summary.reportedCost ?? summary.catalogCost;

    return {
      days,
      present: summary.rows > 0,
      source: "provider-report",
      requests: summary.requests,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      cacheHitRatio: summary.cacheHitRatio,
      catalogCostUsd: money(summary.catalogCost),
      reportedCostUsd: summary.reportedCost === undefined ? null : money(summary.reportedCost),
      effectiveCostUsd: money(effective),
      unpricedRows: summary.unpricedRows,
      daily: imports.dailyCost(tenantId, range).map((d) => ({
        day: d.day,
        costUsd: money(d.cost),
        requests: d.requests,
      })),
      byModel: imports.byModel(tenantId, range).map((m) => ({
        key: m.key,
        costUsd: money(m.cost),
        requests: m.requests,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
      })),
    };
  });

  app.get("/api/spend/daily", async (request) => {
    const days = parseDays(request);
    const buckets = analytics.dailySpend(tenant(request), rangeFor(days));
    return buckets.map((b) => ({ day: b.day, costUsd: money(b.cost), calls: b.calls }));
  });

  app.get("/api/spend/by/:dimension", async (request, reply) => {
    const { dimension } = request.params as { dimension: string };
    const range = rangeFor(parseDays(request));
    const tenantId = tenant(request);

    const rows =
      dimension === "model"
        ? analytics.spendByModel(tenantId, range)
        : dimension === "agent"
          ? analytics.spendByAgent(tenantId, range)
          : dimension === "department"
            ? analytics.spendByDepartment(tenantId, range)
            : undefined;

    if (!rows) {
      return reply.code(400).send({ error: "dimension must be model, agent or department" });
    }

    return rows.map((r) => ({
      key: r.key,
      costUsd: money(r.cost),
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
    }));
  });

  app.get("/api/agents", async (request) => {
    const rows = analytics.agentDetail(tenant(request), rangeFor(parseDays(request)));
    return rows.map((r) => ({
      agentId: r.agentId,
      department: r.department,
      calls: r.calls,
      okCalls: r.okCalls,
      erroredCalls: r.erroredCalls,
      blockedCalls: r.blockedCalls,
      costUsd: money(r.cost),
      costPerCallUsd: money(r.costPerCall),
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheHitRatio: r.cacheHitRatio,
      errorRate: r.errorRate,
      lastSeenAt: r.lastSeenAt,
    }));
  });

  app.get("/api/tiers", async (request) => {
    const rows = analytics.tierBreakdown(tenant(request), rangeFor(parseDays(request)));
    return rows.map((r) => ({
      tier: r.tier,
      tokens: r.tokens,
      costUsd: money(r.cost),
      calls: r.calls,
    }));
  });

  /**
   * The routing curve, plus the caller's own position on it.
   *
   * `observedShare` is measured from traffic; everything else is the model.
   * The response keeps them in separate fields so the UI can label which is
   * which — conflating them is how a forecast gets mistaken for a fact.
   */
  app.get("/api/routing", async (request) => {
    const range = rangeFor(parseDays(request));
    const tenantId = tenant(request);
    const observed = analytics.substitutionShare(tenantId, range);
    const analysis = analyzeRouting(observed);

    return {
      observedShare: observed,
      observedBlendedCost: blendedCost(observed),
      optimalShare: analysis.optimalShare,
      optimalBlendedCost: analysis.optimalCost,
      savingFraction: analysis.savingFraction,
      assumptions: DEFAULT_ASSUMPTIONS,
      curve: costCurve(100).map((p) => ({ share: p.share, cost: p.blendedCost })),
    };
  });

  app.get("/api/models", async () => ({
    // Provenance travels with the prices. A customer's finance team should be
    // able to see when these were last checked and against what, rather than
    // taking the figures on trust.
    catalog: {
      // Each provider is verified against its own page on its own date; the
      // catalog as a whole is only as fresh as its stalest half.
      providers: CATALOG_PROVENANCE,
      verifiedAt: CATALOG_VERIFIED_AT,
      ageDays: catalogAgeDays(),
      staleAfterDays: CATALOG_STALE_AFTER_DAYS,
      stale: isCatalogStale(),
    },
    models: listModelPrices().map((m) => ({
      id: m.id,
      displayName: m.displayName,
      provider: m.provider,
      tier: m.tier,
      retired: m.retired,
      // Per *million* tokens, which is how every provider quotes them.
      inputPerMTokUsd: toUsdString(m.input * 1_000_000n, 2),
      outputPerMTokUsd: toUsdString(m.output * 1_000_000n, 2),
      cacheWrite5mPerMTokUsd: toUsdString(m.cacheWrite5m * 1_000_000n, 3),
      cacheReadPerMTokUsd: toUsdString(m.cacheRead * 1_000_000n, 3),
      longContextInputPerMTokUsd:
        m.longContext === undefined
          ? null
          : toUsdString(m.longContext.input * 1_000_000n, 2),
      longContextThresholdTokens: m.longContext?.thresholdTokens ?? null,
      fastInputPerMTokUsd:
        m.fastInput === undefined ? null : toUsdString(m.fastInput * 1_000_000n, 2),
      fastOutputPerMTokUsd:
        m.fastOutput === undefined ? null : toUsdString(m.fastOutput * 1_000_000n, 2),
    })),
  }));

  app.get("/api/violations", async (request) => {
    const query = request.query as Record<string, unknown> | undefined;
    const limit = query?.["limit"] === undefined ? 50 : Number(query["limit"]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw Object.assign(new Error("limit must be an integer between 1 and 500"), {
        statusCode: 400,
      });
    }
    return analytics.recentViolations(tenant(request), limit);
  });

  // ------------------------------------------------------------- policies

  app.get("/api/policies", async (request) =>
    repository.listPolicies(tenant(request)).map((p) => ({
      id: p.id,
      name: p.name,
      scope: p.scope,
      action: p.action,
      enabled: p.enabled,
      rule:
        p.rule.kind === "budget"
          ? { kind: p.rule.kind, window: p.rule.window, limitUsd: money(p.rule.limit) }
          : p.rule,
    })),
  );

  app.post("/api/policies", async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (!body) return reply.code(400).send({ error: "body required" });

    const parsed = parsePolicyBody(body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });

    const id = repository.createPolicy(tenant(request), parsed.policy);
    return reply.code(201).send({ id });
  });

  app.patch("/api/policies/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown> | undefined;
    const enabled = body?.["enabled"];

    if (typeof enabled !== "boolean") {
      return reply.code(400).send({ error: "body must be { enabled: boolean }" });
    }
    // Scoped to the caller's own tenant so an id from another tenant is a
    // no-op rather than a cross-tenant write.
    const owned = repository.listPolicies(tenant(request)).some((p) => p.id === id);
    if (!owned) return reply.code(404).send({ error: "policy not found" });

    repository.setPolicyEnabled(id, enabled);
    return { id, enabled };
  });
}

type ParsedPolicy =
  | { policy: Parameters<CostGridRepository["createPolicy"]>[1] }
  | { error: string };

/** Validate an untrusted policy payload. This is a write boundary. */
function parsePolicyBody(body: Record<string, unknown>): ParsedPolicy {
  const name = typeof body["name"] === "string" && body["name"] ? body["name"] : "policy";
  const action = body["action"];
  if (action !== "monitor" && action !== "warn" && action !== "block") {
    return { error: "action must be monitor, warn or block" };
  }

  const rawScope = body["scope"] as Record<string, unknown> | undefined;
  const scopeKind = rawScope?.["kind"];
  let scope: Parameters<CostGridRepository["createPolicy"]>[1]["scope"];

  if (scopeKind === "tenant") {
    scope = { kind: "tenant" };
  } else if (scopeKind === "agent" && typeof rawScope?.["agentId"] === "string") {
    scope = { kind: "agent", agentId: rawScope["agentId"] };
  } else if (scopeKind === "department" && typeof rawScope?.["department"] === "string") {
    scope = { kind: "department", department: rawScope["department"] };
  } else {
    return { error: "scope must be {kind:'tenant'|'agent'|'department'} with its identifier" };
  }

  const rawRule = body["rule"] as Record<string, unknown> | undefined;
  const ruleKind = rawRule?.["kind"];

  try {
    if (ruleKind === "budget") {
      const window = rawRule?.["window"];
      if (window !== "day" && window !== "month") return { error: "window must be day or month" };
      if (typeof rawRule?.["limitUsd"] !== "string") {
        return { error: "budget rule needs limitUsd as a decimal string" };
      }
      const threshold = rawRule["threshold"];
      if (threshold !== undefined && (typeof threshold !== "number" || threshold <= 0 || threshold > 1)) {
        return { error: "threshold must be a number in (0, 1]" };
      }
      return {
        policy: {
          name,
          scope,
          action,
          enabled: body["enabled"] !== false,
          rule: {
            kind: "budget",
            window,
            limit: usd(rawRule["limitUsd"]),
            ...(typeof threshold === "number" ? { threshold } : {}),
          },
        },
      };
    }

    if (ruleKind === "model-allowlist" || ruleKind === "model-denylist") {
      const models = rawRule?.["models"];
      if (!Array.isArray(models) || models.length === 0 || !models.every((m) => typeof m === "string")) {
        return { error: `${ruleKind} needs a non-empty array of model ids` };
      }
      return {
        policy: {
          name,
          scope,
          action,
          enabled: body["enabled"] !== false,
          rule: { kind: ruleKind, models: models as string[] },
        },
      };
    }

    if (ruleKind === "max-output-tokens") {
      const limit = rawRule?.["limit"];
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
        return { error: "max-output-tokens needs a positive integer limit" };
      }
      return {
        policy: {
          name,
          scope,
          action,
          enabled: body["enabled"] !== false,
          rule: { kind: "max-output-tokens", limit },
        },
      };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid rule" };
  }

  return { error: "unknown rule kind" };
}
