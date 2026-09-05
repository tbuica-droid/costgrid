import { type Nanodollars, toUsdString } from "./money.js";

/**
 * What CostGrid does when a rule fires.
 *
 * `monitor` records and gets out of the way — the default for a new rule, so a
 * client can see what *would* have happened before anything is enforced.
 * `warn` lets the call through but annotates the response and records a
 * violation. `block` refuses the call before it reaches the provider, which is
 * the only action that actually prevents spend.
 */
export type EnforcementAction = "monitor" | "warn" | "block";

export type PolicyScope =
  | { readonly kind: "tenant" }
  | { readonly kind: "department"; readonly department: string }
  | { readonly kind: "agent"; readonly agentId: string };

export type BudgetWindow = "day" | "month";

export type PolicyRule =
  | {
      readonly kind: "budget";
      readonly window: BudgetWindow;
      /** Spend ceiling for the window, in nanodollars. */
      readonly limit: Nanodollars;
      /**
       * Fire at this fraction of the limit rather than at the limit itself,
       * so a `warn` rule can give warning before a `block` rule bites.
       */
      readonly threshold?: number;
    }
  | { readonly kind: "model-allowlist"; readonly models: readonly string[] }
  | { readonly kind: "model-denylist"; readonly models: readonly string[] }
  | { readonly kind: "max-output-tokens"; readonly limit: number };

export interface Policy {
  readonly id: string;
  readonly name: string;
  readonly scope: PolicyScope;
  readonly rule: PolicyRule;
  readonly action: EnforcementAction;
  readonly enabled: boolean;
}

/** Everything known about a call before it is forwarded upstream. */
export interface RequestContext {
  readonly agentId: string;
  readonly department: string;
  readonly model: string;
  /** `max_tokens` from the request body. */
  readonly maxOutputTokens: number;
}

/**
 * Spend already recorded for the windows a budget rule can reference.
 *
 * These are read from committed rows, so calls still in flight are not
 * included. A burst of concurrent requests can therefore overshoot a cap by
 * roughly one round-trip's worth of spend. That is a deliberate trade: the
 * alternative is serialising every call behind a write lock, which would put
 * CostGrid on the critical path for latency as well as cost.
 */
export interface SpendSnapshot {
  readonly day: Nanodollars;
  readonly month: Nanodollars;
}

/**
 * Resolves spend for a given scope.
 *
 * A budget rule is only meaningful against spend measured over the same scope
 * it applies to — an agent-scoped $10/day cap must compare against that
 * agent's spend, not the whole tenant's. Passing one flat snapshot for every
 * policy would silently make narrow budgets fire on unrelated traffic.
 */
export type SpendResolver = (scope: PolicyScope) => SpendSnapshot;

/** Wrap a single snapshot as a resolver, for callers with only one scope in play. */
export function constantSpend(snapshot: SpendSnapshot): SpendResolver {
  return () => snapshot;
}

export interface PolicyViolation {
  readonly policyId: string;
  readonly policyName: string;
  readonly action: EnforcementAction;
  /** Human-readable reason, surfaced to the caller on a block. */
  readonly reason: string;
}

export interface PolicyDecision {
  /** False only when at least one `block` rule fired. */
  readonly allowed: boolean;
  readonly violations: readonly PolicyViolation[];
  /** The blocking violation, when `allowed` is false. */
  readonly blockedBy: PolicyViolation | undefined;
}

export const ALLOWED: PolicyDecision = { allowed: true, violations: [], blockedBy: undefined };

export const ZERO_SPEND: SpendSnapshot = { day: 0n, month: 0n };

function scopeMatches(scope: PolicyScope, context: RequestContext): boolean {
  switch (scope.kind) {
    case "tenant":
      return true;
    case "department":
      return scope.department === context.department;
    case "agent":
      return scope.agentId === context.agentId;
  }
}

/** Returns a reason string when the rule is violated, otherwise `undefined`. */
function evaluateRule(
  rule: PolicyRule,
  context: RequestContext,
  spend: SpendSnapshot,
): string | undefined {
  switch (rule.kind) {
    case "budget": {
      const threshold = rule.threshold ?? 1;
      if (!(threshold > 0 && threshold <= 1)) {
        throw new RangeError(`budget threshold must be in (0, 1], got ${threshold}`);
      }
      const spent = rule.window === "day" ? spend.day : spend.month;
      // Scale by 1000 to keep the threshold comparison in integer arithmetic.
      const trigger = (rule.limit * BigInt(Math.round(threshold * 1000))) / 1000n;
      if (spent < trigger) return undefined;

      const pct = rule.limit > 0n ? (Number(spent) / Number(rule.limit)) * 100 : 0;
      return (
        `${rule.window}ly spend $${toUsdString(spent, 2)} has reached ` +
        `${pct.toFixed(0)}% of the $${toUsdString(rule.limit, 2)} ${rule.window}ly budget`
      );
    }

    case "model-allowlist":
      if (rule.models.includes(context.model)) return undefined;
      return `model ${context.model} is not on the allowlist for this scope`;

    case "model-denylist":
      if (!rule.models.includes(context.model)) return undefined;
      return `model ${context.model} is explicitly denied for this scope`;

    case "max-output-tokens":
      if (context.maxOutputTokens <= rule.limit) return undefined;
      return `max_tokens ${context.maxOutputTokens} exceeds the cap of ${rule.limit}`;
  }
}

/**
 * Evaluate every policy against one pending request.
 *
 * All matching policies are evaluated even after a block is found, so the
 * violation record shows everything that was wrong with the call rather than
 * just the first thing.
 */
export function evaluatePolicies(
  policies: readonly Policy[],
  context: RequestContext,
  spend: SpendSnapshot | SpendResolver,
): PolicyDecision {
  const resolve: SpendResolver = typeof spend === "function" ? spend : constantSpend(spend);
  const violations: PolicyViolation[] = [];

  for (const policy of policies) {
    if (!policy.enabled) continue;
    if (!scopeMatches(policy.scope, context)) continue;

    // Budget rules are the only ones that read spend, so the resolver is
    // called lazily — scoped spend queries are not free.
    const scopedSpend = policy.rule.kind === "budget" ? resolve(policy.scope) : ZERO_SPEND;
    const reason = evaluateRule(policy.rule, context, scopedSpend);
    if (reason === undefined) continue;

    violations.push({
      policyId: policy.id,
      policyName: policy.name,
      action: policy.action,
      reason,
    });
  }

  const blockedBy = violations.find((v) => v.action === "block");
  return { allowed: blockedBy === undefined, violations, blockedBy };
}
