import { NO_MODIFIERS, parseOpenAiUsage, type PriceModifiers, type TokenUsage, ZERO_USAGE } from "@costgrid/core";
import type { StreamUsageCollector } from "./types.js";

/**
 * Accumulates usage from an OpenAI streamed response.
 *
 * Two differences from Anthropic's stream that matter:
 *
 *   1. Usage is **absent by default**. It only appears if the request carried
 *      `stream_options: {include_usage: true}`, and then only in a single
 *      trailing chunk whose `choices` array is empty. If that chunk never
 *      arrives the call is `incomplete` — recorded with cost unestablished
 *      rather than as zero, so it shows up as unpriced instead of quietly
 *      dragging the reported spend down.
 *   2. Every chunk carries `usage: null` until that final one, so a naive
 *      "last usage wins" would parse null.
 *
 * Also handles the Responses API shape, where totals ride on a terminal
 * `response.completed` event instead.
 */
export class OpenAiStreamCollector implements StreamUsageCollector {
  #buffer = "";
  #usage: TokenUsage = ZERO_USAGE;
  #model: string | undefined;
  #stopReason: string | undefined;
  #parseErrors = 0;
  #sawUsage = false;
  #sawAnyChunk = false;

  feed(chunk: string): void {
    this.#buffer += chunk;

    let newlineIndex: number;
    while ((newlineIndex = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      this.#handleLine(line);
    }

    if (this.#buffer.length > 1_000_000) {
      this.#buffer = "";
      this.#parseErrors += 1;
    }
  }

  end(): void {
    if (this.#buffer.length > 0) {
      this.#handleLine(this.#buffer);
      this.#buffer = "";
    }
  }

  #handleLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) return;

    const payload = line.slice("data:".length).trim();
    // OpenAI terminates a chat stream with a literal [DONE] sentinel.
    if (payload === "" || payload === "[DONE]") return;

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed !== "object" || parsed === null) return;
      event = parsed as Record<string, unknown>;
    } catch {
      this.#parseErrors += 1;
      return;
    }

    try {
      this.#handleEvent(event);
    } catch {
      this.#parseErrors += 1;
    }
  }

  #handleEvent(event: Record<string, unknown>): void {
    this.#sawAnyChunk = true;

    if (typeof event["model"] === "string") this.#model = event["model"];

    // Responses API: totals arrive nested under a terminal response object.
    const response = event["response"];
    if (typeof response === "object" && response !== null && !Array.isArray(response)) {
      const r = response as Record<string, unknown>;
      if (typeof r["model"] === "string") this.#model = r["model"];
      if (r["usage"] != null) {
        this.#usage = parseOpenAiUsage(r["usage"]);
        this.#sawUsage = true;
      }
      if (typeof r["status"] === "string") this.#stopReason = r["status"];
    }

    // Chat Completions: `usage` is null on every chunk but the last.
    if (event["usage"] != null) {
      this.#usage = parseOpenAiUsage(event["usage"]);
      this.#sawUsage = true;
    }

    const choices = event["choices"];
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown> | undefined;
      const reason = first?.["finish_reason"];
      if (typeof reason === "string") this.#stopReason = reason;
    }
  }

  get usage(): TokenUsage {
    return this.#usage;
  }

  get model(): string | undefined {
    return this.#model;
  }

  get stopReason(): string | undefined {
    return this.#stopReason;
  }

  get modifiers(): PriceModifiers {
    // OpenAI has no fast-mode or inference-geography equivalent to read back.
    return NO_MODIFIERS;
  }

  get incomplete(): boolean {
    return !this.#sawUsage;
  }

  get incompleteReason(): string | undefined {
    if (this.#sawUsage) return undefined;
    return this.#sawAnyChunk
      ? "stream carried no usage — the request omitted stream_options.include_usage, " +
          "so this call's cost could not be established"
      : "stream ended before any chunk arrived; usage is unknown";
  }

  get parseErrors(): number {
    return this.#parseErrors;
  }
}
