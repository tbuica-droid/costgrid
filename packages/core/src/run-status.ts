/**
 * How a run ended, from what the proxy recorded about its last call.
 *
 * Providers say why a reply stopped in their own words: Anthropic's
 * `stop_reason`, OpenAI's `finish_reason`, and the Responses API's `status`.
 * Outcome detection only needs to know whether the run ended normally, and if
 * not, in which of a few plain ways.
 */

export type RunStatus = "ok" | "error" | "truncated" | "refused" | "blocked";

/** Replies cut off before the model finished: out of output tokens or context. */
const TRUNCATED = new Set(["max_tokens", "length", "model_context_window_exceeded", "incomplete"]);
/** The model, or the provider's filter, declined to answer. */
const REFUSED = new Set(["refusal", "content_filter"]);

/**
 * `outcome` is the call's recorded outcome (`ok`, `blocked` by a CostGrid
 * rule, or `error`), `statusCode` the HTTP status returned to the caller.
 * A tool the gateway refused after the model asked for it is recorded as
 * `ok` with 403, and counts as blocked.
 */
export function runStatusOf(outcome: string, statusCode: number | null, stopReason: string | null): RunStatus {
  if (outcome === "blocked" || (outcome === "ok" && statusCode === 403)) return "blocked";
  if (outcome === "error" || stopReason === "failed") return "error";
  if (stopReason !== null && TRUNCATED.has(stopReason)) return "truncated";
  if (stopReason !== null && REFUSED.has(stopReason)) return "refused";
  return "ok";
}
