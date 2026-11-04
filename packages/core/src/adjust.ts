import type { Policy, RequestContext } from "./policy.js";
import { scopeMatches } from "./policy.js";
import { effortRank, isReasoningEffort, type ReasoningEffort } from "./reasoning.js";

/**
 * Adjustments: savings that change how a request is sent, not which model
 * answers it.
 *
 * Two rules live here. `lower-reasoning` turns down the reasoning a request asks
 * for, for agents that think at length and answer briefly ("The Illusion of
 * Thinking", arXiv:2506.06941, finds a model that thinks less is often both
 * cheaper and as accurate on simple work). `add-cache` marks the unchanging
 * start of a Claude-format request for caching, so a large prompt sent again
 * and again is billed at the cache-read rate after the first time.
 *
 * Both follow the route rule's guards. `monitor` is a dry run: the call records
 * what would have changed and goes out untouched. A request that already made
 * the choice itself (named no effort, or uses caching already) is never
 * touched, because CostGrid would be guessing at the provider's default or
 * overriding a developer's decision.
 *
 * Pure: the gateway passes the parsed body and gets back a new one.
 */

/** Which wire format the body is in. Bedrock and Vertex carry Claude's. */
export type BodyFormat = "anthropic" | "openai";

export type AdjustmentKind = "lower-reasoning" | "add-cache";

export interface Adjustment {
  readonly policyId: string;
  readonly policyName: string;
  readonly kind: AdjustmentKind;
  /** False for a dry run: recorded, not made. */
  readonly applied: boolean;
  /** What changed, for the call record: `effort:high->low`, `cache:tools,system`. */
  readonly change: string;
}

/** Anthropic's smallest thinking budget; a request below it is refused upstream. */
export const MIN_THINKING_BUDGET = 1024;

/** The lowest effort each format accepts. Claude has no `minimal`. */
const EFFORT_FLOOR: Record<BodyFormat, ReasoningEffort> = { anthropic: "low", openai: "minimal" };

const EPHEMERAL = Object.freeze({ type: "ephemeral" });

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/**
 * The adjustment rules that reach this request: the first enabled one of each
 * kind whose scope matches, the same "first match wins" as routing.
 */
export function adjustmentRulesFor(
  policies: readonly Policy[],
  context: RequestContext,
): Policy[] {
  const out: Policy[] = [];
  const seen = new Set<string>();
  for (const policy of policies) {
    const kind = policy.rule.kind;
    if (!policy.enabled || (kind !== "lower-reasoning" && kind !== "add-cache")) continue;
    if (seen.has(kind) || !scopeMatches(policy.scope, context)) continue;
    seen.add(kind);
    out.push(policy);
  }
  return out;
}

/**
 * Apply the adjustment rules to a request body.
 *
 * Returns the body to send and every change made or, for a dry run, that would
 * have been made. The input is never mutated; with no applied change the same
 * object comes back.
 */
export function applyAdjustments(
  rules: readonly Policy[],
  format: BodyFormat,
  body: unknown,
): { body: unknown; adjustments: Adjustment[] } {
  let out = body;
  const adjustments: Adjustment[] = [];
  for (const policy of rules) {
    const rule = policy.rule;
    const result =
      rule.kind === "lower-reasoning"
        ? lowerReasoning(format, out, rule.effort, rule.budgetTokens)
        : rule.kind === "add-cache"
          ? addCache(format, out)
          : undefined;
    if (result === undefined) continue;
    const applied = policy.action !== "monitor";
    if (applied) out = result.body;
    adjustments.push({
      policyId: policy.id,
      policyName: policy.name,
      kind: rule.kind as AdjustmentKind,
      applied,
      change: result.change,
    });
  }
  return { body: out, adjustments };
}

/** One step down the effort scale, not below what the format accepts. */
export function oneLevelBelow(effort: ReasoningEffort, format: BodyFormat): ReasoningEffort | undefined {
  const rank = effortRank(effort) - 1;
  if (rank < effortRank(EFFORT_FLOOR[format])) return undefined;
  return ["minimal", "low", "medium", "high", "xhigh", "max"][rank] as ReasoningEffort;
}

function lowerReasoning(
  format: BodyFormat,
  body: unknown,
  effort: ReasoningEffort | undefined,
  budgetTokens: number | undefined,
): { body: unknown; change: string } | undefined {
  const request = record(body);
  if (request === undefined) return undefined;

  // A target below what this format accepts means "as low as it goes".
  const floor = EFFORT_FLOOR[format];
  const target =
    effort === undefined ? undefined : effortRank(effort) < effortRank(floor) ? floor : effort;

  const next: Json = { ...request };
  const changes: string[] = [];

  if (target !== undefined) {
    if (format === "anthropic") {
      const config = record(request["output_config"]);
      const asked = config?.["effort"];
      if (isReasoningEffort(asked) && effortRank(asked) > effortRank(target)) {
        next["output_config"] = { ...config, effort: target };
        changes.push(`effort:${asked}->${target}`);
      }
    } else {
      const asked = request["reasoning_effort"];
      const nested = record(request["reasoning"]);
      if (isReasoningEffort(asked) && effortRank(asked) > effortRank(target)) {
        next["reasoning_effort"] = target;
        changes.push(`effort:${asked}->${target}`);
      } else if (isReasoningEffort(nested?.["effort"]) && effortRank(nested["effort"]) > effortRank(target)) {
        next["reasoning"] = { ...nested, effort: target };
        changes.push(`effort:${nested["effort"]}->${target}`);
      }
    }
  }

  if (budgetTokens !== undefined && format === "anthropic") {
    const thinking = record(request["thinking"]);
    const asked = thinking?.["budget_tokens"];
    const cap = Math.max(budgetTokens, MIN_THINKING_BUDGET);
    if (thinking?.["type"] === "enabled" && typeof asked === "number" && asked > cap) {
      next["thinking"] = { ...thinking, budget_tokens: cap };
      changes.push(`budget:${asked}->${cap}`);
    }
  }

  return changes.length === 0 ? undefined : { body: next, change: changes.join(" ") };
}

/** True when any part of a Claude request already asks for caching. */
export function usesCacheControl(request: Json): boolean {
  const marked = (block: unknown): boolean => record(block)?.["cache_control"] !== undefined;
  const system = request["system"];
  if (Array.isArray(system) && system.some(marked)) return true;
  const tools = request["tools"];
  if (Array.isArray(tools) && tools.some(marked)) return true;
  const messages = request["messages"];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const content = record(message)?.["content"];
      if (Array.isArray(content) && content.some(marked)) return true;
    }
  }
  return false;
}

function addCache(format: BodyFormat, body: unknown): { body: unknown; change: string } | undefined {
  // OpenAI caches long prompts on its own; there is no marker to add.
  if (format !== "anthropic") return undefined;
  const request = record(body);
  if (request === undefined || usesCacheControl(request)) return undefined;

  const next: Json = { ...request };
  const marked: string[] = [];

  const tools = request["tools"];
  if (Array.isArray(tools) && tools.length > 0 && record(tools[tools.length - 1]) !== undefined) {
    const copy = [...tools];
    copy[copy.length - 1] = { ...record(copy[copy.length - 1]), cache_control: EPHEMERAL };
    next["tools"] = copy;
    marked.push("tools");
  }

  const system = request["system"];
  if (typeof system === "string" && system !== "") {
    next["system"] = [{ type: "text", text: system, cache_control: EPHEMERAL }];
    marked.push("system");
  } else if (Array.isArray(system) && system.length > 0 && record(system[system.length - 1]) !== undefined) {
    const copy = [...system];
    copy[copy.length - 1] = { ...record(copy[copy.length - 1]), cache_control: EPHEMERAL };
    next["system"] = copy;
    marked.push("system");
  }

  return marked.length === 0 ? undefined : { body: next, change: `cache:${marked.join(",")}` };
}
