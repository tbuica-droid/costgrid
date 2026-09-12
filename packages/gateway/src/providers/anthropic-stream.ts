import {
  NO_MODIFIERS,
  overlayUsage,
  parseAnthropicModifiers,
  parsePartialAnthropicUsage,
  type PriceModifiers,
  type TokenUsage,
  ZERO_USAGE,
} from "@costgrid/core";
import type { StreamUsageCollector } from "./types.js";

/**
 * Extracts usage and model from an Anthropic SSE stream as it passes through.
 *
 * The gateway forwards the stream to the caller byte-for-byte; this collector
 * only observes a copy. It must therefore never throw on malformed input — a
 * metering failure is not a reason to break a client's response — so parse
 * errors are counted and surfaced afterwards rather than raised.
 *
 * Two properties of the wire format drive the design:
 *
 *   1. Chunk boundaries fall anywhere, including mid-line, so lines are
 *      reassembled from a buffer rather than parsed per chunk.
 *   2. `message_delta.usage.output_tokens` is cumulative, not incremental.
 *      Fields are therefore overlaid, never summed.
 */
export class AnthropicStreamCollector implements StreamUsageCollector {
  #buffer = "";
  #usage: TokenUsage = ZERO_USAGE;
  #model: string | undefined;
  #stopReason: string | undefined;
  #modifiers: PriceModifiers = NO_MODIFIERS;
  #parseErrors = 0;
  #sawMessageStart = false;

  /** Feed a raw chunk of the response body. Safe to call with partial lines. */
  feed(chunk: string): void {
    this.#buffer += chunk;

    // Keep the trailing fragment; it will be completed by a later chunk.
    let newlineIndex: number;
    while ((newlineIndex = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newlineIndex);
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      this.#handleLine(line);
    }

    // A stream that never emits a trailing newline would otherwise grow the
    // buffer without bound. Anthropic terminates every event with a blank
    // line, so anything this large is a malformed stream, not a slow one.
    if (this.#buffer.length > 1_000_000) {
      this.#buffer = "";
      this.#parseErrors += 1;
    }
  }

  /** Flush any final line that arrived without a trailing newline. */
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
    switch (event["type"]) {
      case "message_start": {
        const message = event["message"];
        if (typeof message !== "object" || message === null) return;
        const m = message as Record<string, unknown>;

        this.#sawMessageStart = true;
        // The model the provider actually served, which can differ from the
        // one requested — a server-side fallback after a refusal, for one.
        // Billing must follow what ran, not what was asked for.
        if (typeof m["model"] === "string") this.#model = m["model"];
        if (m["usage"] !== undefined) {
          this.#usage = overlayUsage(this.#usage, parsePartialAnthropicUsage(m["usage"]));
          // speed / inference_geo arrive on message_start and decide the rate.
          this.#modifiers = { ...this.#modifiers, ...parseAnthropicModifiers(m["usage"]) };
        }
        return;
      }

      case "message_delta": {
        if (event["usage"] !== undefined) {
          this.#usage = overlayUsage(this.#usage, parsePartialAnthropicUsage(event["usage"]));
          this.#modifiers = { ...this.#modifiers, ...parseAnthropicModifiers(event["usage"]) };
        }
        const delta = event["delta"];
        if (typeof delta === "object" && delta !== null) {
          const reason = (delta as Record<string, unknown>)["stop_reason"];
          if (typeof reason === "string") this.#stopReason = reason;
        }
        return;
      }

      default:
        return;
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
    return this.#modifiers;
  }

  /**
   * True when the stream never produced a `message_start`, which means the
   * recorded usage is not trustworthy — the connection dropped, or the
   * response was an error rather than a message stream.
   */
  get incomplete(): boolean {
    return !this.#sawMessageStart;
  }

  get incompleteReason(): string | undefined {
    return this.#sawMessageStart ? undefined : "stream ended before message_start; usage is partial";
  }

  get parseErrors(): number {
    return this.#parseErrors;
  }
}
