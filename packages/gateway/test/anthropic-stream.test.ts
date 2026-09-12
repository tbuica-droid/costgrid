import { describe, expect, it } from "vitest";
import { AnthropicStreamCollector } from "../src/providers/anthropic-stream.js";

const MESSAGE_START = JSON.stringify({
  type: "message_start",
  message: {
    id: "msg_01",
    model: "claude-opus-5",
    usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 800 },
  },
});

function events(...lines: string[]): string {
  return lines.map((l) => `event: x\ndata: ${l}\n\n`).join("");
}

describe("AnthropicStreamCollector", () => {
  it("takes input and cache counts from message_start", () => {
    const c = new AnthropicStreamCollector();
    c.feed(events(MESSAGE_START));
    c.end();

    expect(c.model).toBe("claude-opus-5");
    expect(c.usage.inputTokens).toBe(1200);
    expect(c.usage.cacheReadTokens).toBe(800);
  });

  it("replaces output_tokens from message_delta rather than summing them", () => {
    const c = new AnthropicStreamCollector();
    c.feed(
      events(
        MESSAGE_START,
        JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 40 } }),
        JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 90 } }),
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 137 },
        }),
      ),
    );
    c.end();

    // Cumulative semantics: the final value, not 40 + 90 + 137.
    expect(c.usage.outputTokens).toBe(137);
    expect(c.usage.inputTokens).toBe(1200); // not erased by the deltas
    expect(c.stopReason).toBe("end_turn");
    expect(c.incomplete).toBe(false);
  });

  it("reassembles events split across arbitrary chunk boundaries", () => {
    const whole = events(
      MESSAGE_START,
      JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 500 } }),
    );

    // Feed one character at a time — the worst case for a line-based parser.
    const c = new AnthropicStreamCollector();
    for (const char of whole) c.feed(char);
    c.end();

    expect(c.usage.inputTokens).toBe(1200);
    expect(c.usage.outputTokens).toBe(500);
    expect(c.parseErrors).toBe(0);
  });

  it("handles CRLF line endings", () => {
    const c = new AnthropicStreamCollector();
    c.feed(`event: message_start\r\ndata: ${MESSAGE_START}\r\n\r\n`);
    c.end();
    expect(c.usage.inputTokens).toBe(1200);
  });

  it("records the model the provider actually served", () => {
    const c = new AnthropicStreamCollector();
    c.feed(
      events(
        JSON.stringify({
          type: "message_start",
          message: { model: "claude-opus-4-8", usage: { input_tokens: 5 } },
        }),
      ),
    );
    c.end();
    // Requested model may have been Fable 5.1; a server-side fallback served 4.8.
    expect(c.model).toBe("claude-opus-4-8");
  });

  it("ignores [DONE] sentinels, comments and unrelated events", () => {
    const c = new AnthropicStreamCollector();
    c.feed(
      `: keep-alive\n` +
        events(
          MESSAGE_START,
          JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } }),
          JSON.stringify({ type: "message_stop" }),
        ) +
        "data: [DONE]\n\n",
    );
    c.end();

    expect(c.parseErrors).toBe(0);
    expect(c.usage.inputTokens).toBe(1200);
  });

  it("counts malformed payloads instead of throwing", () => {
    const c = new AnthropicStreamCollector();
    c.feed("data: {not json\n\n");
    c.feed(events(MESSAGE_START));
    c.end();

    expect(c.parseErrors).toBe(1);
    // A bad line does not prevent the good ones from being metered.
    expect(c.usage.inputTokens).toBe(1200);
  });

  it("flags a stream that never produced a message_start as untrustworthy", () => {
    const c = new AnthropicStreamCollector();
    c.feed(events(JSON.stringify({ type: "message_delta", usage: { output_tokens: 10 } })));
    c.end();
    expect(c.incomplete).toBe(true);
  });

  it("reads the split 5m/1h cache_creation shape", () => {
    const c = new AnthropicStreamCollector();
    c.feed(
      events(
        JSON.stringify({
          type: "message_start",
          message: {
            model: "claude-opus-5",
            usage: {
              input_tokens: 10,
              cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 },
            },
          },
        }),
      ),
    );
    c.end();

    expect(c.usage.cacheWrite5mTokens).toBe(300);
    expect(c.usage.cacheWrite1hTokens).toBe(700);
  });

  it("picks up pricing modifiers from the stream", () => {
    const c = new AnthropicStreamCollector();
    c.feed(
      events(
        JSON.stringify({
          type: "message_start",
          message: {
            model: "claude-opus-5",
            usage: { input_tokens: 10, speed: "fast", inference_geo: "us" },
          },
        }),
      ),
    );
    c.end();

    // A streamed fast-mode call bills at double; missing this halves the bill.
    expect(c.modifiers).toEqual({ speed: "fast", inferenceGeo: "us" });
  });

  it("reports no modifiers on an ordinary stream", () => {
    const c = new AnthropicStreamCollector();
    c.feed(events(MESSAGE_START));
    c.end();
    expect(c.modifiers).toEqual({});
  });

  it("does not grow its buffer without bound on a stream with no newlines", () => {
    const c = new AnthropicStreamCollector();
    c.feed("data: ".concat("x".repeat(2_000_000)));
    c.end();
    expect(c.parseErrors).toBeGreaterThan(0);
  });
});
