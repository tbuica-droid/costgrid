import { anthropicAdapter, openaiAdapter } from "./providers/index.js";
import type { ProviderAdapter } from "./providers/types.js";

/**
 * A read-only analyst that explains the numbers in plain English.
 *
 * The point of it is the interface, not the intelligence. CostGrid can answer
 * "why did spend go up last week" from data it already holds, but only through
 * a terminal command and a dashboard tab that assume you know what to look
 * for. A question in ordinary words is a better door.
 *
 * Three rules hold it in place:
 *
 *   1. **It reads and explains. It never acts.** No rule it suggests is
 *      applied, no budget it mentions is set. The deterministic engine keeps
 *      every decision, because the product's credibility is that the numbers
 *      are exact and a model is not exact.
 *   2. **It sees only the briefing.** A fixed set of figures, assembled
 *      elsewhere, which the customer can print in full before enabling any of
 *      this. Never prompts, never completions, never tool arguments — none of
 *      which CostGrid stores in the first place.
 *   3. **Its arithmetic is checked.** Every money figure in the answer is
 *      matched against the briefing, and anything it made up is reported
 *      alongside the answer rather than left for the reader to catch.
 */

/** Which wire format to speak. Most vendors, xAI included, speak OpenAI's. */
export type AnalystWire = "anthropic" | "openai";

export interface AnalystConfig {
  readonly wire: AnalystWire;
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string | undefined;
  /** True when this is running on CostGrid's own key rather than the customer's. */
  readonly demo?: boolean;
}

export interface AnalystAnswer {
  readonly text: string;
  /**
   * Money figures in the answer that do not appear in the briefing.
   *
   * Not proof of a mistake: a correct total of two briefing figures is not
   * itself in the briefing. It is proof that a number was not read straight
   * off the data, which is the only distinction worth flagging automatically.
   */
  readonly unverified: readonly string[];
  readonly model: string;
  readonly demo: boolean;
}

const SYSTEM = [
  "You are the analyst inside CostGrid, a tool that measures what a company's software spends on AI.",
  "",
  "You are given a briefing of exact figures. Answer the question from those figures and nothing else.",
  "",
  "Rules:",
  "- Write for a business owner, not an engineer. Short sentences. No jargon.",
  "- Quote figures exactly as they appear in the briefing. Never estimate, never round.",
  "- If the briefing does not answer the question, say so plainly and say what would.",
  "- Never invent a number. If you are combining figures, say which ones.",
  "- Lead with the answer. Two or three sentences is usually right; never more than six.",
  "- Do not suggest running commands. Someone else handles that.",
].join("\n");

function adapterFor(wire: AnalystWire): ProviderAdapter {
  return wire === "anthropic" ? anthropicAdapter : openaiAdapter;
}

function defaultBaseUrl(wire: AnalystWire): string {
  return adapterFor(wire).defaultBaseUrl;
}

/**
 * Money figures the answer contains that the briefing does not.
 *
 * Deliberately blunt: exact string matching on the rendered amounts. A looser
 * check would have to decide what counts as "close enough", and a cost tool is
 * the wrong place to start rounding.
 */
export function unverifiedFigures(answer: string, briefing: string): string[] {
  /*
   * Both sides are tokenised the same way and compared as whole figures.
   * A plain substring test looks right and is not: a briefing containing
   * "$110.00" would vouch for an answer that said "$10.00", which is exactly
   * the kind of number this check exists to catch.
   */
  const figures = (text: string) => text.match(/\$[\d,]+(?:\.\d+)?/g) ?? [];
  const known = new Set(figures(briefing));

  const seen = new Set<string>();
  const missing: string[] = [];
  for (const figure of figures(answer)) {
    if (seen.has(figure)) continue;
    seen.add(figure);
    if (!known.has(figure)) missing.push(figure);
  }
  return missing;
}

function requestBody(config: AnalystConfig, briefing: string, question: string): unknown {
  const user = `Briefing:\n\n${briefing}\n\nQuestion: ${question}`;

  if (config.wire === "anthropic") {
    return {
      model: config.model,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    };
  }
  return {
    model: config.model,
    max_completion_tokens: 700,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
  };
}

function textOf(wire: AnalystWire, payload: unknown): string {
  const body = payload as Record<string, unknown>;
  if (wire === "anthropic") {
    const content = body["content"];
    if (!Array.isArray(content)) return "";
    return content
      .map((block) => {
        const b = block as Record<string, unknown>;
        return b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "";
      })
      .join("")
      .trim();
  }
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as Record<string, unknown>)["message"] as
    | Record<string, unknown>
    | undefined;
  return typeof message?.["content"] === "string" ? message["content"].trim() : "";
}

export async function ask(
  config: AnalystConfig,
  briefing: string,
  question: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AnalystAnswer> {
  const adapter = adapterFor(config.wire);
  const base = config.baseUrl ?? defaultBaseUrl(config.wire);
  const url = new URL(adapter.upstreamPath(config.model, false), base);
  const bytes = JSON.stringify(requestBody(config, briefing, question));

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(await adapter.authHeaders(config.apiKey, { method: "POST", url, body: bytes })),
  };
  if (config.wire === "anthropic") headers["anthropic-version"] = "2023-06-01";

  const response = await fetchImpl(url, { method: "POST", headers, body: bytes });
  const text = await response.text();

  if (!response.ok) {
    // The vendor's own message is the actionable part; wrapping it in ours
    // would only hide the reason.
    throw new Error(`${config.model} returned ${response.status}: ${text.slice(0, 300)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${config.model} returned something that was not JSON`);
  }

  const answer = textOf(config.wire, payload);
  if (answer === "") throw new Error(`${config.model} returned an empty answer`);

  return {
    text: answer,
    unverified: unverifiedFigures(answer, briefing),
    model: config.model,
    demo: config.demo === true,
  };
}
