/**
 * Checks on the answer itself: did it come back in the shape the agent's
 * owner said a good answer has?
 *
 * Cheap, deterministic, and run on every final answer CostGrid sees whole.
 * The answer is read in memory and only the one-word result is kept: the
 * text is never stored.
 *
 *   - `cut-off`: the model ran out of room (`max_tokens`, `length`).
 *   - `refusal`: the model declined (`refusal`, `content_filter`, or an
 *     OpenAI `refusal` message).
 *   - `not-json`: the agent expects JSON and the answer does not parse.
 *   - `missing-field`: it parses, but a required top-level field is absent.
 *   - `pass`: none of the above.
 *
 * A response that ends by asking for a tool is a step in a job, not its
 * answer, and is not judged (`undefined`).
 */

export type AnswerCheck = "pass" | "cut-off" | "refusal" | "not-json" | "missing-field";

export const ANSWER_CHECKS: readonly AnswerCheck[] = ["pass", "cut-off", "refusal", "not-json", "missing-field"];

export interface AnswerSpec {
  /** `any` checks only how the answer ended. */
  readonly format: "any" | "json";
  /** Top-level fields a JSON answer must have. Names only. */
  readonly requiredFields?: readonly string[];
}

export const ANY_ANSWER: AnswerSpec = { format: "any" };

const CUT_OFF = new Set(["max_tokens", "length", "model_context_window_exceeded"]);
const REFUSED = new Set(["refusal", "content_filter"]);
const STEP = new Set(["tool_use", "tool_calls", "function_call", "pause_turn"]);

type Json = Record<string, unknown>;
const record = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;

/** The visible text of a Claude or OpenAI response body, and whether it was refused outright. */
export function answerOf(payload: unknown): { text: string | undefined; refused: boolean } {
  const body = record(payload);
  if (body === undefined) return { text: undefined, refused: false };
  const content = body["content"];
  if (Array.isArray(content)) {
    const text = content
      .map((block) => (record(block)?.["type"] === "text" ? String(record(block)!["text"] ?? "") : ""))
      .join("");
    return { text, refused: false };
  }
  const message = record(record(Array.isArray(body["choices"]) ? body["choices"][0] : undefined)?.["message"]);
  if (message !== undefined) {
    const refusal = message["refusal"];
    return {
      text: typeof message["content"] === "string" ? message["content"] : undefined,
      refused: typeof refusal === "string" && refusal !== "",
    };
  }
  return { text: undefined, refused: false };
}

/** JSON from an answer that may wrap it in a fenced block, as models often do. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

/**
 * Judge one answer. `text` is undefined when the whole answer was not seen
 * (a stream): then only how it ended is judged, never its format.
 */
export function checkAnswer(
  input: { stopReason: string | undefined; text: string | undefined; refused?: boolean },
  spec: AnswerSpec = ANY_ANSWER,
): AnswerCheck | undefined {
  const stop = input.stopReason;
  if (stop !== undefined && STEP.has(stop)) return undefined;
  if (input.refused === true || (stop !== undefined && REFUSED.has(stop))) return "refusal";
  if (stop !== undefined && CUT_OFF.has(stop)) return "cut-off";
  if (spec.format !== "json") return "pass";
  // Format needs the whole answer. Without it, say nothing rather than "pass".
  if (input.text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = parseJson(input.text);
  } catch {
    return "not-json";
  }
  const fields = spec.requiredFields ?? [];
  if (fields.length === 0) return "pass";
  const object = record(parsed);
  if (object === undefined) return "missing-field";
  return fields.every((f) => Object.prototype.hasOwnProperty.call(object, f)) ? "pass" : "missing-field";
}

/** What a person did with an answer, as the customer's software reported it. */
const FELL_SHORT = new Set(["edited", "rejected", "handed-off"]);

/**
 * Whether one run's work met the quality bar, from whatever evidence there is.
 *
 * Below the bar when its last answer failed a check, a person edited,
 * rejected or took over the answer, or a reported score was under the bar.
 * Met when the evidence is positive. Undefined when there is none.
 * Any negative evidence wins: a high score does not excuse a cut-off answer.
 */
export function qualityOf(
  evidence: { check?: AnswerCheck | undefined; qualityMilli?: number | undefined; signal?: string | undefined },
  barMilli: number,
): "met" | "below" | undefined {
  const { check, qualityMilli, signal } = evidence;
  if (check !== undefined && check !== "pass") return "below";
  if (signal !== undefined && FELL_SHORT.has(signal)) return "below";
  if (qualityMilli !== undefined && qualityMilli < barMilli) return "below";
  if (check === "pass" || signal === "accepted" || qualityMilli !== undefined) return "met";
  return undefined;
}
