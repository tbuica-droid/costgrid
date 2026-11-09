/**
 * Reasoning: what a request asks the model to think, and what it reports back.
 *
 * Two research findings make this worth a module of its own. Reasoning tokens
 * are the largest single driver of the gap between a model's list price and
 * what a task actually costs (Chen et al., "The Price Reversal Phenomenon",
 * arXiv:2603.23971), and more reasoning does not reliably buy a better answer:
 * on simple tasks a model that thinks less is often both cheaper and more
 * accurate (Shojaee et al., "The Illusion of Thinking", arXiv:2506.06941).
 *
 * So CostGrid records how much reasoning each call asked for, records how many
 * reasoning tokens it was billed for wherever the provider says, and lets a
 * customer cap the first.
 *
 * What the providers report differs, and the difference is stated rather than
 * papered over:
 *
 *   - OpenAI reports reasoning tokens per call
 *     (`completion_tokens_details.reasoning_tokens`, or
 *     `output_tokens_details.reasoning_tokens` on the Responses API). They are
 *     already inside the output count and bill at the output rate.
 *   - Anthropic does not split thinking out of `output_tokens`. For Claude
 *     traffic CostGrid can say how much reasoning was *requested* (an effort
 *     level, or a thinking budget on older models) but not how many of the
 *     output tokens were thinking. It never estimates the split.
 */

/**
 * Effort levels, cheapest first.
 *
 * The union of both providers' vocabularies. OpenAI's `none` (no reasoning)
 * and `minimal` sit below `low`; `xhigh` and Anthropic's `max` sit above `high`. Order is the only
 * thing compared, so a level one provider does not offer never matches
 * anything it sends.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof EFFORT_LEVELS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Position on the scale, so two levels can be compared. */
export function effortRank(effort: ReasoningEffort): number {
  return EFFORT_LEVELS.indexOf(effort);
}

/**
 * What one request asked for, read from its body before it is forwarded.
 *
 * Every field is optional because every field can be absent from a real
 * request, and absent is not the same as zero: a request that names no effort
 * gets whatever the provider's default is for that model, which CostGrid does
 * not know and does not guess.
 */
export interface ReasoningRequest {
  /** An effort level the request set explicitly. */
  readonly effort?: ReasoningEffort;
  /** A fixed thinking budget in tokens, on models that still take one. */
  readonly budgetTokens?: number;
  /** True when the request switched thinking on, adaptively or by budget. */
  readonly thinking?: boolean;
}

/**
 * A short, stable label for the call record: `effort:high`, `budget:8000`,
 * `thinking`, or `undefined` when the request said nothing about reasoning.
 */
export function describeReasoning(request: ReasoningRequest | undefined): string | undefined {
  if (request === undefined) return undefined;
  const parts: string[] = [];
  if (request.effort !== undefined) parts.push(`effort:${request.effort}`);
  if (request.budgetTokens !== undefined) parts.push(`budget:${request.budgetTokens}`);
  if (parts.length === 0 && request.thinking === true) parts.push("thinking");
  return parts.length === 0 ? undefined : parts.join(" ");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read an Anthropic-shaped request body: the direct API, Bedrock and Vertex.
 *
 * `output_config.effort` is the current control. `thinking: {type: "enabled",
 * budget_tokens}` is the older one, still accepted by some models; `adaptive`
 * switches thinking on with no fixed budget.
 */
export function anthropicReasoningOf(body: unknown): ReasoningRequest | undefined {
  const request = record(body);
  if (request === undefined) return undefined;

  const effort = record(request["output_config"])?.["effort"];
  const thinking = record(request["thinking"]);
  const type = thinking?.["type"];
  const budget = thinking?.["budget_tokens"];

  const result: { effort?: ReasoningEffort; budgetTokens?: number; thinking?: boolean } = {};
  if (isReasoningEffort(effort)) result.effort = effort;
  if (type === "enabled" || type === "adaptive") result.thinking = true;
  if (type === "enabled" && typeof budget === "number" && Number.isInteger(budget) && budget > 0) {
    result.budgetTokens = budget;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * Read an OpenAI request body: `reasoning_effort` on Chat Completions,
 * `reasoning.effort` on the Responses API.
 */
export function openAiReasoningOf(body: unknown): ReasoningRequest | undefined {
  const request = record(body);
  if (request === undefined) return undefined;
  const effort = request["reasoning_effort"] ?? record(request["reasoning"])?.["effort"];
  return isReasoningEffort(effort) ? { effort, thinking: true } : undefined;
}

/**
 * Reasoning tokens from an OpenAI `usage` object, or `undefined` when the
 * provider did not report any.
 *
 * Undefined rather than zero, because "not reported" and "none used" are
 * different facts, and a share computed over calls that never reported would
 * understate the real figure.
 */
export function parseOpenAiReasoningTokens(raw: unknown): number | undefined {
  const usage = record(raw);
  if (usage === undefined) return undefined;
  const details = record(usage["completion_tokens_details"] ?? usage["output_tokens_details"]);
  const value = details?.["reasoning_tokens"];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/** OpenAI models that take every level from none to xhigh. */
const OPENAI_NONE_TO_XHIGH = new Set([
  "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2",
]);

/**
 * The effort levels a model accepts, cheapest first; empty when it takes none.
 *
 * Lowering effort to a level the model does not take, or moving a call that
 * names an effort to a model without one, makes the provider reject the call
 * outright, so adjustments and model switches only ever choose from this list.
 *
 *   - OpenAI, as its API listed each model's levels on 8 November 2026: the
 *     original GPT-5 family takes minimal to high; later GPT-5.x and GPT-6
 *     models take none (no reasoning) to xhigh, except GPT-6 Astra, GPT-6.1
 *     Sol and o3, which start at low, and GPT-5.1, which stops at high. The
 *     `-pro` models run at high only. GPT-4.1 and GPT-4o do not reason and
 *     reject `reasoning_effort`. A model not named here gets low to high.
 *   - Claude, checked against the live API on 8 November 2026: Opus 4.6 and
 *     Sonnet 4.6 take max but not xhigh, Opus 4.5 stops at high, and Sonnet
 *     4.5, Haiku 4.5 and everything older take no effort at all. Newer models
 *     take all five; so does a model not named here.
 */
export function effortsAccepted(model: string, provider: string): readonly ReasoningEffort[] {
  const id = model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, "");
  if (provider === "openai") {
    if (/^(gpt-4\.1|gpt-4o|chatgpt-4o)/.test(id)) return [];
    if (/(^|-)pro$/.test(id)) return ["high"];
    if (/^gpt-5(-mini|-nano)?$/.test(id)) return ["minimal", "low", "medium", "high"];
    if (OPENAI_NONE_TO_XHIGH.has(id)) return ["none", "low", "medium", "high", "xhigh"];
    if (id === "gpt-5.1") return ["none", "low", "medium", "high"];
    if (id === "gpt-6-astra" || id === "gpt-6.1-sol" || id === "o3") return ["low", "medium", "high", "xhigh"];
    return ["low", "medium", "high"];
  }
  if (/^claude-(3|haiku-3|instant)|^claude-(sonnet|haiku)-4-5$|^claude-(sonnet|opus)-4(-1)?$/.test(id)) return [];
  if (id === "claude-opus-4-5") return ["low", "medium", "high"];
  if (id === "claude-opus-4-6" || id === "claude-sonnet-4-6") return ["low", "medium", "high", "max"];
  return ["low", "medium", "high", "xhigh", "max"];
}
