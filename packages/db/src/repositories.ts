import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  EnforcementAction,
  Nanodollars,
  Policy,
  PolicyRule,
  PolicyScope,
  PolicyViolation,
  PriceModifiers,
  SpendSnapshot,
  TokenUsage,
} from "@costgrid/core";
import type { CostBreakdown, RateOverride } from "@costgrid/core";
import type { Db } from "./database.js";

export type CallOutcome = "ok" | "blocked" | "error";

export interface CallRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly department: string;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly streamed: boolean;
  readonly usage: TokenUsage;
  readonly cost: CostBreakdown;
  /**
   * Catalog price before any negotiated rate.
   *
   * `cost` is what the customer actually pays. This is what the list price
   * would have been, kept so a discount is provable rather than asserted.
   * Omit it and it equals `cost`, which is the truth when no rate is in force.
   */
  readonly costList?: CostBreakdown | undefined;
  readonly priced: boolean;
  /** Pricing modifiers in effect, so the row's cost is reproducible. */
  readonly modifiers?: PriceModifiers | undefined;
  /** What the caller asked for, when a route rule changed it. */
  readonly requestedModel?: string | undefined;
  readonly routed?: boolean | undefined;
  /** True when a route rule matched but was in dry-run mode. */
  readonly routeDryRun?: boolean | undefined;
  /** Counterfactual: requested-model cost minus actual. Signed. */
  readonly savingEstimate?: Nanodollars | undefined;
  /**
   * The run this call belongs to. Omit and the call becomes a run of one.
   *
   * `runDeclared` records whether the caller supplied it or CostGrid invented
   * it, because run-scoped policies are meaningless on an invented one.
   */
  readonly runId?: string | undefined;
  readonly runDeclared?: boolean | undefined;
  readonly parentRunId?: string | undefined;
  readonly runDepth?: number | undefined;
  readonly outcome: CallOutcome;
  readonly statusCode?: number | undefined;
  readonly stopReason?: string | undefined;
  readonly errorMessage?: string | undefined;
}

/** A run's consumption so far, as read on the metering path. */
export interface RunStats {
  readonly spend: Nanodollars;
  /** Calls already recorded for this run. Blocked calls do not count. */
  readonly steps: number;
  /** Delegation hops from the root run. Zero when there is no parent. */
  readonly depth: number;
}

/** A rate override as stored, with the evidence that produced it. */
export interface StoredRateOverride extends RateOverride {
  readonly evidence?:
    | {
        readonly from: number;
        readonly to: number;
        readonly reported: Nanodollars;
        readonly catalog: Nanodollars;
      }
    | undefined;
  readonly updatedAt?: number | undefined;
}

export interface CreatedApiKey {
  readonly id: string;
  readonly tenantId: string;
  /** Shown once at creation and never recoverable. */
  readonly plaintext: string;
  readonly prefix: string;
}

export interface ResolvedApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
}

const KEY_PREFIX = "cg_live_";

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * Boundaries of the UTC day and month containing `at`.
 *
 * UTC, not local time, so a budget window means the same thing to a gateway in
 * Frankfurt and a dashboard in New York. A per-tenant billing timezone is the
 * obvious next refinement; hardcoding UTC first keeps the ambiguity out.
 */
export function windowBounds(at: number): { dayStart: number; monthStart: number } {
  const d = new Date(at);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return { dayStart, monthStart };
}

export class CostGridRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  // ---------------------------------------------------------------- tenants

  createTenant(name: string, id: string = randomUUID()): string {
    this.#db
      .prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)")
      .run(id, name, Date.now());
    return id;
  }

  getTenant(id: string): { id: string; name: string } | undefined {
    return this.#db.prepare("SELECT id, name FROM tenants WHERE id = ?").get(id) as
      | { id: string; name: string }
      | undefined;
  }

  // --------------------------------------------------------------- api keys

  /**
   * Mint an API key. The plaintext is returned once; only its SHA-256 hash is
   * stored, so this value cannot be recovered from a database dump.
   */
  createApiKey(tenantId: string, name: string): CreatedApiKey {
    const secret = randomBytes(24).toString("base64url");
    const plaintext = `${KEY_PREFIX}${secret}`;
    const id = randomUUID();
    const prefix = plaintext.slice(0, KEY_PREFIX.length + 6);

    this.#db
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, name, key_hash, key_prefix, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tenantId, name, hashKey(plaintext), prefix, Date.now());

    return { id, tenantId, plaintext, prefix };
  }

  /**
   * Resolve a presented key to its tenant, or `undefined` if it is unknown or
   * revoked.
   *
   * The lookup is by hash, so the comparison the database performs is against
   * a digest rather than the secret. The extra `timingSafeEqual` guards the
   * final confirmation against a timing oracle on the hash itself.
   */
  resolveApiKey(plaintext: string): ResolvedApiKey | undefined {
    if (!plaintext.startsWith(KEY_PREFIX)) return undefined;

    const digest = hashKey(plaintext);
    const row = this.#db
      .prepare(
        `SELECT id, tenant_id AS tenantId, name, key_hash AS keyHash
         FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
      )
      .get(digest) as { id: string; tenantId: string; name: string; keyHash: string } | undefined;

    if (!row) return undefined;

    const a = Buffer.from(digest, "hex");
    const b = Buffer.from(row.keyHash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

    return { id: row.id, tenantId: row.tenantId, name: row.name };
  }

  /** Keys a tenant has, without any secret material. */
  listApiKeys(tenantId: string): {
    id: string;
    name: string;
    prefix: string;
    createdAt: number;
    revokedAt: number | null;
  }[] {
    return this.#db
      .prepare(
        `SELECT id, name, key_prefix AS prefix, created_at AS createdAt, revoked_at AS revokedAt
         FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`,
      )
      .all(tenantId) as {
      id: string;
      name: string;
      prefix: string;
      createdAt: number;
      revokedAt: number | null;
    }[];
  }

  revokeApiKey(id: string): void {
    this.#db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
  }

  // ----------------------------------------------------------------- agents

  /** Register an agent on first sight, so metering never drops an unknown caller. */
  touchAgent(tenantId: string, agentId: string, department: string): void {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO agents (id, tenant_id, department, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           department   = excluded.department`,
      )
      .run(agentId, tenantId, department, now, now);
  }

  // ------------------------------------------------------------------ calls

  recordCall(call: CallRecord): void {
    this.#db
      .prepare(
        `INSERT INTO calls (
           id, tenant_id, agent_id, department, provider, model,
           started_at, duration_ms, streamed,
           input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens,
           cost_input, cost_output, cost_cache_write, cost_cache_read, cost_total, priced,
           outcome, status_code, stop_reason, error_message,
           speed, inference_geo, batch,
           requested_model, routed, route_dry_run, saving_estimate,
           run_id, parent_run_id, run_depth, run_declared, cost_list
         ) VALUES (
           @id, @tenantId, @agentId, @department, @provider, @model,
           @startedAt, @durationMs, @streamed,
           @inputTokens, @outputTokens, @cacheWrite5m, @cacheWrite1h, @cacheRead,
           @costInput, @costOutput, @costCacheWrite, @costCacheRead, @costTotal, @priced,
           @outcome, @statusCode, @stopReason, @errorMessage,
           @speed, @inferenceGeo, @batch,
           @requestedModel, @routed, @routeDryRun, @savingEstimate,
           @runId, @parentRunId, @runDepth, @runDeclared, @costList
         )`,
      )
      .run({
        id: call.id,
        tenantId: call.tenantId,
        agentId: call.agentId,
        department: call.department,
        provider: call.provider,
        model: call.model,
        startedAt: call.startedAt,
        durationMs: call.durationMs,
        streamed: call.streamed ? 1 : 0,
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
        cacheWrite5m: call.usage.cacheWrite5mTokens,
        cacheWrite1h: call.usage.cacheWrite1hTokens,
        cacheRead: call.usage.cacheReadTokens,
        costInput: call.cost.input,
        costOutput: call.cost.output,
        costCacheWrite: call.cost.cacheWrite,
        costCacheRead: call.cost.cacheRead,
        costTotal: call.cost.total,
        priced: call.priced ? 1 : 0,
        outcome: call.outcome,
        statusCode: call.statusCode ?? null,
        stopReason: call.stopReason ?? null,
        errorMessage: call.errorMessage ?? null,
        speed: call.modifiers?.speed ?? null,
        inferenceGeo: call.modifiers?.inferenceGeo ?? null,
        batch: call.modifiers?.batch === true ? 1 : 0,
        requestedModel: call.requestedModel ?? null,
        routed: call.routed === true ? 1 : 0,
        routeDryRun: call.routeDryRun === true ? 1 : 0,
        savingEstimate: call.savingEstimate ?? 0n,
        // A call with no declared run is its own run, so every row joins to
        // exactly one run and the analytics never need a null branch.
        runId: call.runId ?? call.id,
        parentRunId: call.parentRunId ?? null,
        runDepth: call.runDepth ?? 0,
        runDeclared: call.runDeclared === true ? 1 : 0,
        costList: call.costList?.total ?? call.cost.total,
      });
  }

  /**
   * Spend for one scope, over the UTC day and month containing `at`.
   *
   * Only `outcome = 'ok'` rows count: a blocked call never reached the
   * provider and a failed one must not inflate a budget the client was not
   * charged for.
   */
  spendFor(tenantId: string, scope: PolicyScope, at = Date.now()): SpendSnapshot {
    const { dayStart, monthStart } = windowBounds(at);

    let filter = "";
    const scopeParams: unknown[] = [];
    if (scope.kind === "agent") {
      filter = " AND agent_id = ?";
      scopeParams.push(scope.agentId);
    } else if (scope.kind === "department") {
      filter = " AND department = ?";
      scopeParams.push(scope.department);
    }

    const query = this.#db
      .prepare(
        `SELECT COALESCE(SUM(cost_total), 0) AS total
         FROM calls
         WHERE tenant_id = ? AND outcome = 'ok' AND started_at >= ?${filter}`,
      )
      // Money is read as bigint so a large aggregate cannot silently lose
      // precision past 2^53 nanodollars (~$9M).
      .safeIntegers(true);

    const day = (query.get(tenantId, dayStart, ...scopeParams) as { total: bigint }).total;
    const month = (query.get(tenantId, monthStart, ...scopeParams) as { total: bigint }).total;
    return { day, month };
  }

  /**
   * What a run has consumed so far, read before its next call is forwarded.
   *
   * Depth comes from the parent run rather than from a recursive walk: the
   * parent already resolved its own depth when it ran, so one indexed lookup
   * gives the answer that recursion would. A parent nobody metered reads as
   * depth 0, which understates rather than invents.
   *
   * Like `spendFor`, this reads committed rows, so a run fanning out in
   * parallel can overshoot its cap by roughly one round trip. Sequential runs
   * — which is most agent loops — are exact.
   */
  runStats(tenantId: string, runId: string, parentRunId?: string): RunStats {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN outcome = 'ok' THEN cost_total ELSE 0 END), 0) AS spend,
                COALESCE(SUM(CASE WHEN outcome != 'blocked' THEN 1 ELSE 0 END), 0)    AS steps
         FROM calls
         WHERE tenant_id = ? AND run_id = ?`,
      )
      .safeIntegers(true)
      .get(tenantId, runId) as { spend: bigint; steps: bigint };

    let depth = 0;
    if (parentRunId !== undefined) {
      const parent = this.#db
        .prepare(
          `SELECT run_depth AS depth FROM calls
           WHERE tenant_id = ? AND run_id = ?
           ORDER BY started_at LIMIT 1`,
        )
        .get(tenantId, parentRunId) as { depth: number } | undefined;
      depth = (parent?.depth ?? 0) + 1;
    }

    return { spend: row.spend, steps: Number(row.steps), depth };
  }

  /**
   * The agents further up this run's delegation chain, nearest first.
   *
   * Walked one indexed lookup at a time rather than in a recursive CTE,
   * because the walk needs two guards that are awkward to express in SQL and
   * essential here: a visited set, so a cycle in the delegation graph cannot
   * spin this query on the request path, and a hard hop cap, so a pathological
   * chain costs a bounded number of reads before a call is forwarded. This
   * runs before every request that carries a parent-run header, so its worst
   * case is a latency number, not a background job.
   *
   * A parent run nobody metered ends the walk. That understates the chain
   * rather than inventing one, which is the right way for a boundary to fail:
   * `policy list` reports run coverage so the gap is visible.
   */
  delegationChain(tenantId: string, parentRunId: string, maxHops = 32): string[] {
    const lookup = this.#db.prepare(
      `SELECT agent_id AS agentId, parent_run_id AS parentRunId
       FROM calls
       WHERE tenant_id = ? AND run_id = ?
       ORDER BY started_at LIMIT 1`,
    );

    const chain: string[] = [];
    const seen = new Set<string>();
    let runId: string | undefined = parentRunId;

    for (let hop = 0; hop < maxHops && runId !== undefined; hop += 1) {
      if (seen.has(runId)) break;
      seen.add(runId);

      const row = lookup.get(tenantId, runId) as
        | { agentId: string; parentRunId: string | null }
        | undefined;
      if (row === undefined) break;

      if (!chain.includes(row.agentId)) chain.push(row.agentId);
      runId = row.parentRunId ?? undefined;
    }

    return chain;
  }

  /**
   * Record the tools a call touched.
   *
   * `invoked` is what the model asked to run, kept per call so a run can be
   * audited step by step. `granted` is what the request said it *may* run,
   * aggregated because the thousandth identical declaration is not a
   * thousandth fact — and because capability is worth seeing before it is
   * first exercised, not after.
   *
   * One transaction, after the response has already gone back to the caller.
   */
  recordTools(input: {
    tenantId: string;
    callId: string;
    runId: string;
    agentId: string;
    invoked: readonly string[];
    granted: readonly string[];
    at: number;
  }): void {
    if (input.invoked.length === 0 && input.granted.length === 0) return;

    const insertInvocation = this.#db.prepare(
      `INSERT INTO tool_invocations (id, tenant_id, call_id, run_id, agent_id, tool_name, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertGrant = this.#db.prepare(
      `INSERT INTO tool_grants (tenant_id, agent_id, tool_name, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, agent_id, tool_name)
       DO UPDATE SET last_seen = excluded.last_seen`,
    );

    this.#db.transaction(() => {
      for (const tool of input.invoked) {
        insertInvocation.run(
          randomUUID(),
          input.tenantId,
          input.callId,
          input.runId,
          input.agentId,
          tool,
          input.at,
        );
      }
      for (const tool of input.granted) {
        upsertGrant.run(input.tenantId, input.agentId, tool, input.at, input.at);
      }
    })();
  }

  /** The negotiated rate in force for a provider, if any. */
  rateOverride(tenantId: string, provider: string): StoredRateOverride | undefined {
    const row = this.#db
      .prepare(
        `SELECT provider, numerator, denominator, source,
                evidence_from AS evidenceFrom, evidence_to AS evidenceTo,
                evidence_reported AS evidenceReported, evidence_catalog AS evidenceCatalog,
                updated_at AS updatedAt
         FROM rate_overrides WHERE tenant_id = ? AND provider = ?`,
      )
      .safeIntegers(true)
      .get(tenantId, provider) as Record<string, bigint | string> | undefined;

    return row === undefined ? undefined : toStoredRate(row);
  }

  listRateOverrides(tenantId: string): StoredRateOverride[] {
    const rows = this.#db
      .prepare(
        `SELECT provider, numerator, denominator, source,
                evidence_from AS evidenceFrom, evidence_to AS evidenceTo,
                evidence_reported AS evidenceReported, evidence_catalog AS evidenceCatalog,
                updated_at AS updatedAt
         FROM rate_overrides WHERE tenant_id = ? ORDER BY provider`,
      )
      .safeIntegers(true)
      .all(tenantId) as Record<string, bigint | string>[];
    return rows.map(toStoredRate);
  }

  setRateOverride(tenantId: string, override: StoredRateOverride, at = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO rate_overrides (
           tenant_id, provider, numerator, denominator, source,
           evidence_from, evidence_to, evidence_reported, evidence_catalog, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           numerator = excluded.numerator,
           denominator = excluded.denominator,
           source = excluded.source,
           evidence_from = excluded.evidence_from,
           evidence_to = excluded.evidence_to,
           evidence_reported = excluded.evidence_reported,
           evidence_catalog = excluded.evidence_catalog,
           updated_at = excluded.updated_at`,
      )
      .run(
        tenantId,
        override.provider,
        override.numerator,
        override.denominator,
        override.source,
        override.evidence?.from ?? null,
        override.evidence?.to ?? null,
        override.evidence?.reported ?? null,
        override.evidence?.catalog ?? null,
        at,
      );
  }

  clearRateOverride(tenantId: string, provider: string): boolean {
    const result = this.#db
      .prepare("DELETE FROM rate_overrides WHERE tenant_id = ? AND provider = ?")
      .run(tenantId, provider);
    return result.changes > 0;
  }

  // --------------------------------------------------------------- policies

  createPolicy(tenantId: string, policy: Omit<Policy, "id"> & { id?: string }): string {
    const id = policy.id ?? randomUUID();
    const scopeValue =
      policy.scope.kind === "agent"
        ? policy.scope.agentId
        : policy.scope.kind === "department"
          ? policy.scope.department
          : null;

    this.#db
      .prepare(
        `INSERT INTO policies (id, tenant_id, name, scope_kind, scope_value, rule_json, action, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        policy.name,
        policy.scope.kind,
        scopeValue,
        serializeRule(policy.rule),
        policy.action,
        policy.enabled ? 1 : 0,
        Date.now(),
      );
    return id;
  }

  /**
   * Names of enabled tool rules across every tenant.
   *
   * Used once, at boot, to refuse to start a gateway that carries tool
   * boundaries it cannot enforce. Matching on the serialised rule rather than
   * parsing every policy keeps this to one indexed-free scan of a small table
   * at a moment when nothing is serving traffic yet.
   */
  toolPolicyNames(): string[] {
    const rows = this.#db
      .prepare(
        `SELECT name FROM policies
         WHERE enabled = 1
           AND (rule_json LIKE '%"tool-denylist"%' OR rule_json LIKE '%"tool-allowlist"%')
         ORDER BY created_at`,
      )
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  listPolicies(tenantId: string): Policy[] {
    const rows = this.#db
      .prepare(
        `SELECT id, name, scope_kind AS scopeKind, scope_value AS scopeValue,
                rule_json AS ruleJson, action, enabled
         FROM policies WHERE tenant_id = ? ORDER BY created_at`,
      )
      .all(tenantId) as {
      id: string;
      name: string;
      scopeKind: PolicyScope["kind"];
      scopeValue: string | null;
      ruleJson: string;
      action: EnforcementAction;
      enabled: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      scope: deserializeScope(row.scopeKind, row.scopeValue),
      rule: deserializeRule(row.ruleJson),
      action: row.action,
      enabled: row.enabled === 1,
    }));
  }

  setPolicyEnabled(id: string, enabled: boolean): void {
    this.#db.prepare("UPDATE policies SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  // ------------------------------------------------------------- violations

  recordViolations(
    tenantId: string,
    callId: string,
    violations: readonly PolicyViolation[],
    at = Date.now(),
  ): void {
    if (violations.length === 0) return;

    const insert = this.#db.prepare(
      `INSERT INTO violations (id, tenant_id, call_id, policy_id, policy_name, action, reason, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#db.transaction(() => {
      for (const v of violations) {
        insert.run(randomUUID(), tenantId, callId, v.policyId, v.policyName, v.action, v.reason, at);
      }
    })();
  }
}

// Rules are stored as JSON because they are a discriminated union whose
// variants have different shapes; a column per field would be mostly NULLs.
//
// JSON cannot carry a bigint, and money here is always one. This used to name
// the budget rule explicitly, which meant the first other rule to carry money
// — the run budget — crashed on write. The encoding is self-describing
// instead: any bigint, on any rule, present or future, round-trips without
// anyone remembering to add it to a list.

/** Marks a value that was a bigint before it met JSON. */
interface NanoTag {
  readonly __nano: string;
}

function isNanoTag(value: unknown): value is NanoTag {
  return typeof value === "object" && value !== null && typeof (value as NanoTag).__nano === "string";
}

function serializeRule(rule: PolicyRule): string {
  return JSON.stringify(rule, (_key, value: unknown) =>
    typeof value === "bigint" ? ({ __nano: value.toString() } satisfies NanoTag) : value,
  );
}

function deserializeRule(json: string): PolicyRule {
  const parsed = JSON.parse(json, (_key, value: unknown) =>
    isNanoTag(value) ? BigInt(value.__nano) : value,
  ) as Record<string, unknown>;

  // Rows written before the tagged encoding stored a budget's limit as a bare
  // decimal string. Those rows are in customers' databases, so they are read
  // here rather than migrated: a rewrite of live policy rows is a worse risk
  // than three lines of compatibility.
  if (parsed["kind"] === "budget" && typeof parsed["limit"] === "string") {
    return { ...parsed, limit: BigInt(parsed["limit"]) } as unknown as PolicyRule;
  }
  return parsed as unknown as PolicyRule;
}

function deserializeScope(kind: PolicyScope["kind"], value: string | null): PolicyScope {
  switch (kind) {
    case "tenant":
      return { kind: "tenant" };
    case "agent":
      if (value === null) throw new Error("agent-scoped policy has no agent id");
      return { kind: "agent", agentId: value };
    case "department":
      if (value === null) throw new Error("department-scoped policy has no department");
      return { kind: "department", department: value };
  }
}

export type { Nanodollars };

function toStoredRate(row: Record<string, bigint | string>): StoredRateOverride {
  const from = row["evidenceFrom"];
  return {
    provider: row["provider"] as string,
    numerator: row["numerator"] as bigint,
    denominator: row["denominator"] as bigint,
    source: row["source"] as "manual" | "derived",
    ...(from != null
      ? {
          evidence: {
            from: Number(from),
            to: Number(row["evidenceTo"]),
            reported: row["evidenceReported"] as bigint,
            catalog: row["evidenceCatalog"] as bigint,
          },
        }
      : {}),
    updatedAt: Number(row["updatedAt"]),
  };
}
