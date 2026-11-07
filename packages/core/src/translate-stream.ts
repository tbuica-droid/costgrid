import { claudeUsageToOpenAi, finishToStop, openAiUsageToClaude, stopToFinish } from "./translate.js";

/**
 * Streams, translated event by event as they arrive, so a caller written for
 * one format can read a stream served in the other without waiting for the
 * whole answer.
 *
 * Each translator takes raw text as it comes off the wire (chunks may split
 * an event anywhere) and returns the text to send on, possibly empty. `end()`
 * flushes whatever the closing events need. Metering never reads the
 * translated stream: it reads the provider's own, so cost stays exact.
 */

export interface StreamTranslator {
  push(chunk: string): string;
  end(): string;
}

type Json = Record<string, unknown>;
const record = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;

/** Splits SSE text into the `data:` payloads of complete events. */
class SseLines {
  #buffer = "";

  push(chunk: string): string[] {
    this.#buffer += chunk.replace(/\r\n/g, "\n");
    const out: string[] = [];
    let end: number;
    while ((end = this.#buffer.indexOf("\n\n")) !== -1) {
      const event = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data !== "") out.push(data);
    }
    return out;
  }
}

const claudeEvent = (type: string, data: Json): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** OpenAI chat completion chunks, read as Claude Messages stream events. */
export class OpenAiToClaudeStream implements StreamTranslator {
  readonly #lines = new SseLines();
  readonly #model: string;
  #started = false;
  #ended = false;
  /** The open content block: its index, and which tool call it is, if any. */
  #block: { index: number; tool?: number } | undefined;
  #next = 0;
  #stop: string | null = null;
  #usage: Json | undefined;

  constructor(model: string) {
    this.#model = model;
  }

  push(chunk: string): string {
    let out = "";
    for (const data of this.#lines.push(chunk)) {
      if (data === "[DONE]") {
        out += this.#finish();
        continue;
      }
      let parsed: Json | undefined;
      try {
        parsed = record(JSON.parse(data));
      } catch {
        continue;
      }
      if (parsed === undefined) continue;
      out += this.#start(parsed);
      if (parsed["usage"] !== undefined && parsed["usage"] !== null) this.#usage = openAiUsageToClaude(parsed["usage"]);
      const choice = record(Array.isArray(parsed["choices"]) ? parsed["choices"][0] : undefined);
      if (choice === undefined) continue;
      const delta = record(choice["delta"]) ?? {};
      if (typeof delta["content"] === "string" && delta["content"] !== "") {
        if (this.#block === undefined || this.#block.tool !== undefined) {
          out += this.#close();
          this.#block = { index: this.#next++ };
          out += claudeEvent("content_block_start", { index: this.#block.index, content_block: { type: "text", text: "" } });
        }
        out += claudeEvent("content_block_delta", { index: this.#block.index, delta: { type: "text_delta", text: delta["content"] } });
      }
      for (const call of Array.isArray(delta["tool_calls"]) ? delta["tool_calls"].map(record) : []) {
        if (call === undefined) continue;
        const fn = record(call["function"]) ?? {};
        const which = Number(call["index"] ?? 0);
        if (this.#block?.tool !== which) {
          out += this.#close();
          this.#block = { index: this.#next++, tool: which };
          out += claudeEvent("content_block_start", {
            index: this.#block.index,
            content_block: { type: "tool_use", id: call["id"] ?? `toolu_${which}`, name: fn["name"] ?? "", input: {} },
          });
        }
        if (typeof fn["arguments"] === "string" && fn["arguments"] !== "") {
          out += claudeEvent("content_block_delta", {
            index: this.#block.index,
            delta: { type: "input_json_delta", partial_json: fn["arguments"] },
          });
        }
      }
      if (choice["finish_reason"] != null) this.#stop = finishToStop(choice["finish_reason"]);
    }
    return out;
  }

  end(): string {
    return this.#finish();
  }

  #start(chunk: Json): string {
    if (this.#started) return "";
    this.#started = true;
    return claudeEvent("message_start", {
      message: {
        id: chunk["id"] ?? "msg_costgrid",
        type: "message",
        role: "assistant",
        model: this.#model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  #close(): string {
    if (this.#block === undefined) return "";
    const out = claudeEvent("content_block_stop", { index: this.#block.index });
    this.#block = undefined;
    return out;
  }

  #finish(): string {
    if (this.#ended || !this.#started) return "";
    this.#ended = true;
    const usage = this.#usage ?? { input_tokens: 0, output_tokens: 0 };
    return (
      this.#close() +
      claudeEvent("message_delta", { delta: { stop_reason: this.#stop ?? "end_turn", stop_sequence: null }, usage }) +
      claudeEvent("message_stop", {})
    );
  }
}

/** Claude Messages stream events, read as OpenAI chat completion chunks. */
export class ClaudeToOpenAiStream implements StreamTranslator {
  readonly #lines = new SseLines();
  readonly #model: string;
  readonly #includeUsage: boolean;
  readonly #created: number;
  #id = "chatcmpl-costgrid";
  #ended = false;
  /** Claude block index → OpenAI tool call index. */
  readonly #tools = new Map<number, number>();
  #usage: Json = {};
  #finish: string | null = null;

  /** `includeUsage` mirrors the caller's own `stream_options.include_usage`. */
  constructor(model: string, includeUsage: boolean, created = Math.floor(Date.now() / 1000)) {
    this.#model = model;
    this.#includeUsage = includeUsage;
    this.#created = created;
  }

  #chunk(delta: Json, finish: string | null = null): string {
    return `data: ${JSON.stringify({
      id: this.#id,
      object: "chat.completion.chunk",
      created: this.#created,
      model: this.#model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  }

  push(chunk: string): string {
    let out = "";
    for (const data of this.#lines.push(chunk)) {
      let event: Json | undefined;
      try {
        event = record(JSON.parse(data));
      } catch {
        continue;
      }
      switch (event?.["type"]) {
        case "message_start": {
          const message = record(event["message"]) ?? {};
          if (typeof message["id"] === "string") this.#id = message["id"];
          this.#usage = { ...this.#usage, ...(record(message["usage"]) ?? {}) };
          out += this.#chunk({ role: "assistant", content: "" });
          break;
        }
        case "content_block_start": {
          const block = record(event["content_block"]) ?? {};
          if (block["type"] === "tool_use") {
            const which = this.#tools.size;
            this.#tools.set(Number(event["index"]), which);
            out += this.#chunk({
              tool_calls: [{ index: which, id: block["id"], type: "function", function: { name: block["name"], arguments: "" } }],
            });
          }
          break;
        }
        case "content_block_delta": {
          const delta = record(event["delta"]) ?? {};
          if (delta["type"] === "text_delta") out += this.#chunk({ content: delta["text"] });
          else if (delta["type"] === "input_json_delta") {
            const which = this.#tools.get(Number(event["index"])) ?? 0;
            out += this.#chunk({ tool_calls: [{ index: which, function: { arguments: delta["partial_json"] } }] });
          }
          break;
        }
        case "message_delta": {
          this.#finish = stopToFinish(record(event["delta"])?.["stop_reason"]);
          this.#usage = { ...this.#usage, ...(record(event["usage"]) ?? {}) };
          break;
        }
        case "message_stop":
          out += this.end();
          break;
      }
    }
    return out;
  }

  end(): string {
    if (this.#ended) return "";
    this.#ended = true;
    let out = this.#chunk({}, this.#finish ?? "stop");
    if (this.#includeUsage) {
      out += `data: ${JSON.stringify({
        id: this.#id,
        object: "chat.completion.chunk",
        created: this.#created,
        model: this.#model,
        choices: [],
        usage: claudeUsageToOpenAi(this.#usage),
      })}\n\n`;
    }
    return out + "data: [DONE]\n\n";
  }
}
