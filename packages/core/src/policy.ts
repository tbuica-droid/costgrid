import { type Nanodollars, toUsdString } from "./money.js";
import { findModelPrice } from "./pricing.js";

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
      /**
       * Soft fallback: when set, traffic over this budget is downgraded to
       * this model instead of being refused.
       *
       * A hard cap protects the bill by breaking the customer's product, which
       * is why most teams never turn one on. A fallback keeps the product
       * answering on a cheaper model, so the cap becomes something they are
       * willing to set. It changes what `block` means for this rule: an
       * over-budget call is downgraded rather than refused, and only falls
       * back to refusal when the substitution cannot be made safely (see
       * `substitutionAllowed`) — for instance when the traffic is already on
       * the fallback model and there is nothing cheaper left to give.
       *
       * Use `--action warn` for a rule that will never block under any
       * circumstance, at the cost of the cap no longer being a true ceiling:
       * spend keeps accruing at the cheaper model's rate.
       */
      readonly fallbackModel?: string;
    }
  | { readonly kind: "model-allowlist"; readonly models: readonly string[] }
  | { readonly kind: "model-denylist"; readonly models: readonly string[] }
  | { readonly kind: "max-output-tokens"; readonly limit: number }
  | {
      /**
       * Send this traffic to a cheaper model than the caller asked for.
       *
       * The only rule that *changes* a request rather than permitting or
       * refusing it, which makes it the one with real blast radius: routing
       * a nuanced task to a small model degrades the customer's product
       * quietly, and they will blame their own code before they blame us.
       *
       * Three guards, all enforced rather than advised:
       *   - `monitor` is a genuine dry-run. Nothing is rewritten; the call is
       *     recorded with what *would* have happened and what it would have
       *     saved. This is how a customer builds confidence before enabling.
       *   - `from` narrows the rule to specific source models, so "everything
       *     goes to Haiku" has to be written deliberately rather than reached
       *     by accident.
       *   - The target must be the same provider (checked at evaluation), as
       *     an Anthropic request body is not a valid OpenAI one.
       */
      readonly kind: "route";
      /** Source models this applies to. Empty or absent means any model. */
      readonly from?: readonly string[];
      readonly toModel: string;
    };

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

/**
 * A model substitution chosen by a `route` rule.
 *
 * `applied` is false for a dry-run: the caller still gets the model they
 * asked for, but the call records the counterfactual so the saving is
 * measurable before anything is switched on.
 */
export interface RouteDecision {
  readonly policyId: string;
  readonly policyName: string;
  readonly fromModel: string;
  readonly toModel: string;
  readonly applied: boolean;
  /**
   * True when this substitution came from a budget rule's soft fallback rather
   * than from a standing `route` rule. Callers are told which, because "your
   * request was downgraded because you are over budget" and "your traffic is
   * routed here by policy" need different responses from a human.
   */
  readonly fallback: boolean;
  readonly reason: string;
}

export interface PolicyDecision {
  /** False only when at least one `block` rule fired. */
  readonly allowed: boolean;
  readonly violations: readonly PolicyViolation[];
  /** The blocking violation, when `allowed` is false. */
  readonly blockedBy: PolicyViolation | undefined;
  /**
   * The model substitution to make, if any. At most one: rules are evaluated
   * in order and the first matching route wins, so two overlapping rules
   * cannot chain a request through several models.
   */
  readonly route: RouteDecision | undefined;
}

export const ALLOWED: PolicyDecision = {
  allowed: true,
  violations: [],
  blockedBy: undefined,
  route: undefined,
};

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

    case "route":
      // Routing is handled separately; it transforms rather than permits.
      return undefined;
  }
}

/**
 * Is substituting `toModel` for `fromModel` safe to do?
 *
 * False when the target is the same model (a no-op), when it is not in the
 * price catalog, or when it belongs to a different provider.
 *
 * The cross-provider check is not a nicety. An Anthropic request body is not a
 * valid OpenAI one, so rewriting `model` across providers would send a
 * malformed request upstream and break the caller's feature outright. Refusing
 * an unpriceable target matters just as much: the customer would see their
 * traffic move and their reported spend go to zero.
 */
export function substitutionAllowed(fromModel: string, toModel: string): boolean {
  if (toModel === fromModel) return false;
  const target = findModelPrice(toModel);
  if (!target) return false;
  const source = findModelPrice(fromModel);
  return !source || source.provider === target.provider;
}

/**
 * Decide whether a route rule applies to this request.
 *
 * Returns `undefined` when it does not match, or when applying it would be
 * unsafe.
 */
function evaluateRoute(
  policy: Policy,
  rule: Extract<PolicyRule, { kind: "route" }>,
  context: RequestContext,
): RouteDecision | undefined {
  if (rule.from !== undefined && rule.from.length > 0 && !rule.from.includes(context.model)) {
    return undefined;
  }
  if (!substitutionAllowed(context.model, rule.toModel)) return undefined;

  const applied = policy.action !== "monitor";
  return {
    policyId: policy.id,
    policyName: policy.name,
    fromModel: context.model,
    toModel: rule.toModel,
    applied,
    fallback: false,
    reason: applied
      ? `routed from ${context.model} to ${rule.toModel} by "${policy.name}"`
      : `would route from ${context.model} to ${rule.toModel} (dry run)`,
  };
}

/**
 * The substitution a fired budget rule wants to make instead of refusing.
 *
 * `undefined` means there is no usable downgrade, and the rule's own action
 * stands — so a `block` budget with an unusable fallback still blocks. That is
 * the honest outcome: the cap the customer set is still a cap, and the only
 * way it silently stops being one is if we invent a substitution we cannot
 * make.
 */
function evaluateFallback(
  policy: Policy,
  fallbackModel: string,
  context: RequestContext,
): RouteDecision | undefined {
  if (!substitutionAllowed(context.model, fallbackModel)) return undefined;

  const applied = policy.action !== "monitor";
  return {
    policyId: policy.id,
    policyName: policy.name,
    fromModel: context.model,
    toModel: fallbackModel,
    applied,
    fallback: true,
    reason: applied
      ? `over budget: downgraded from ${context.model} to ${fallbackModel} by "${policy.name}"`
      : `over budget: would downgrade from ${context.model} to ${fallbackModel} (dry run)`,
  };
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
  let route: RouteDecision | undefined;
  let fallback: RouteDecision | undefined;

  for (const policy of policies) {
    if (!policy.enabled) continue;
    if (!scopeMatches(policy.scope, context)) continue;

    if (policy.rule.kind === "route") {
      // First match wins, so overlapping rules cannot chain a request through
      // several models.
      route ??= evaluateRoute(policy, policy.rule, context);
      continue;
    }

    // Budget rules are the only ones that read spend, so the resolver is
    // called lazily — scoped spend queries are not free.
    const scopedSpend = policy.rule.kind === "budget" ? resolve(policy.scope) : ZERO_SPEND;
    const reason = evaluateRule(policy.rule, context, scopedSpend);
    if (reason === undefined) continue;

    const downgrade =
      policy.rule.kind === "budget" && policy.rule.fallbackModel !== undefined
        ? evaluateFallback(policy, policy.rule.fallbackModel, context)
        : undefined;

    if (downgrade === undefined) {
      violations.push({
        policyId: policy.id,
        policyName: policy.name,
        action: policy.action,
        reason,
      });
      continue;
    }

    fallback ??= downgrade;
    // A fired budget with a usable fallback never blocks — the whole point is
    // that the caller keeps getting an answer. It is still a violation, so it
    // still shows up in the enforcement feed and in the response warnings.
    violations.push({
      policyId: policy.id,
      policyName: policy.name,
      action: downgrade.applied ? "warn" : "monitor",
      reason,
    });
  }

  const blockedBy = violations.find((v) => v.action === "block");
  // A soft fallback outranks a standing route rule: it is the emergency
  // measure, and the budget it protects is the more urgent constraint.
  const chosen = fallback ?? route;
  // A blocked call is never routed: it is not going anywhere.
  return {
    allowed: blockedBy === undefined,
    violations,
    blockedBy,
    route: blockedBy === undefined ? chosen : undefined,
  };
}
