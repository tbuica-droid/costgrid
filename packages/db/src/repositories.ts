import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  EnforcementAction,
  Nanodollars,
  Policy,
  PolicyRule,
  PolicyScope,
  PolicyViolation,
  SpendSnapshot,
  TokenUsage,
} from "@costgrid/core";
import type { CostBreakdown } from "@costgrid/core";
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
  readonly priced: boolean;
  readonly outcome: CallOutcome;
  readonly statusCode?: number | undefined;
  readonly stopReason?: string | undefined;
  readonly errorMessage?: string | undefined;
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
           outcome, status_code, stop_reason, error_message
         ) VALUES (
           @id, @tenantId, @agentId, @department, @provider, @model,
           @startedAt, @durationMs, @streamed,
           @inputTokens, @outputTokens, @cacheWrite5m, @cacheWrite1h, @cacheRead,
           @costInput, @costOutput, @costCacheWrite, @costCacheRead, @costTotal, @priced,
           @outcome, @statusCode, @stopReason, @errorMessage
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
// The `limit` on a budget rule is a bigint, which JSON cannot carry, so it is
// written as a decimal string and restored on read.

function serializeRule(rule: PolicyRule): string {
  if (rule.kind === "budget") {
    return JSON.stringify({ ...rule, limit: rule.limit.toString() });
  }
  return JSON.stringify(rule);
}

function deserializeRule(json: string): PolicyRule {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (parsed["kind"] === "budget") {
    return { ...parsed, limit: BigInt(parsed["limit"] as string) } as unknown as PolicyRule;
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
