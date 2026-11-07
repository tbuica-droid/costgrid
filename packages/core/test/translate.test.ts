import { describe, expect, it } from "vitest";
import {
  claudeResponseToOpenAi,
  claudeToOpenAi,
  ClaudeToOpenAiStream,
  costOfOpen,
  openAiResponseToClaude,
  openAiToClaude,
  OpenAiToClaudeStream,
  parseOpenModel,
  usd,
  ZERO_USAGE,
} from "../src/index.js";

const CLAUDE_REQUEST = {
  model: "claude-sonnet-4-6",
  max_tokens: 500,
  system: [{ type: "text", text: "You are support." }],
  temperature: 0.2,
  stop_sequences: ["END"],
  stream: true,
  tools: [{ name: "lookup", description: "Find an order", input_schema: { type: "object", properties: { id: { type: "string" } } } }],
  tool_choice: { type: "any", disable_parallel_tool_use: true },
  messages: [
    { role: "user", content: [{ type: "text", text: "Where is " }, { type: "text", text: "order 7?" }] },
    { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "lookup", input: { id: "7" } }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "shipped" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        { type: "text", text: "and this?" },
      ],
    },
  ],
};

describe("Claude request → OpenAI", () => {
  it("maps system, messages, tool calls and results, images, tools and choice", () => {
    const out = claudeToOpenAi(CLAUDE_REQUEST, "gpt-5-mini", "openai");
    expect(out).toEqual({
      ok: true,
      body: {
        model: "gpt-5-mini",
        max_completion_tokens: 500,
        temperature: 0.2,
        stream: true,
        stop: ["END"],
        messages: [
          { role: "system", content: "You are support." },
          { role: "user", content: "Where is order 7?" },
          {
            role: "assistant",
            content: "Checking.",
            tool_calls: [{ id: "t1", type: "function", function: { name: "lookup", arguments: '{"id":"7"}' } }],
          },
          { role: "tool", tool_call_id: "t1", content: "shipped" },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
              { type: "text", text: "and this?" },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: { name: "lookup", description: "Find an order", parameters: { type: "object", properties: { id: { type: "string" } } } },
          },
        ],
        tool_choice: "required",
        parallel_tool_calls: false,
      },
    });
  });

  it("uses max_tokens for open-model hosts", () => {
    const out = claudeToOpenAi({ max_tokens: 10, messages: [{ role: "user", content: "hi" }] }, "llama", "open");
    expect(out.ok && out.body).toMatchObject({ max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
  });

  it("refuses what it cannot carry, and says why", () => {
    const cases: [unknown, string][] = [
      [{ ...CLAUDE_REQUEST, thinking: { type: "enabled", budget_tokens: 2000 } }, "thinking"],
      [{ ...CLAUDE_REQUEST, output_config: { effort: "low" } }, "output_config"],
      [{ messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] }, "cache control"],
      [{ messages: [], tools: [{ type: "web_search_20250305", name: "web_search" }] }, "server tool"],
      [{ messages: [{ role: "user", content: [{ type: "document", source: {} }] }] }, "document"],
      [{ messages: [], top_k: 5 }, "top_k"],
    ];
    for (const [request, word] of cases) {
      const out = claudeToOpenAi(request, "m", "openai");
      expect(out.ok).toBe(false);
      expect(!out.ok && out.reason).toContain(word);
    }
  });
});

describe("OpenAI request → Claude", () => {
  it("maps system, tool turns, images, tools and choice, and fills max_tokens", () => {
    const out = openAiToClaude(
      {
        model: "gpt-5",
        stream: true,
        stop: "END",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "developer", content: "Use tools." },
          { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "https://x/y.png" } }] },
          { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] },
          { role: "tool", tool_call_id: "c1", content: "one" },
          { role: "tool", tool_call_id: "c2", content: "two" },
        ],
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
        tool_choice: { type: "function", function: { name: "f" } },
      },
      "claude-haiku-4-5",
    );
    expect(out).toEqual({
      ok: true,
      body: {
        model: "claude-haiku-4-5",
        max_tokens: 4096,
        system: "Be brief.\n\nUse tools.",
        stream: true,
        stop_sequences: ["END"],
        messages: [
          { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", source: { type: "url", url: "https://x/y.png" } }] },
          { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "f", input: { a: 1 } }] },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "c1", content: "one" },
              { type: "tool_result", tool_use_id: "c2", content: "two" },
            ],
          },
        ],
        tools: [{ name: "f", input_schema: { type: "object" } }],
        tool_choice: { type: "tool", name: "f" },
      },
    });
  });

  it("refuses what Claude cannot honour", () => {
    for (const extra of [{ n: 2 }, { response_format: { type: "json_object" } }, { logprobs: true }, { temperature: 1.5 }, { reasoning_effort: "low" }]) {
      expect(openAiToClaude({ messages: [], ...extra }, "claude-haiku-4-5").ok).toBe(false);
    }
  });
});

describe("responses and usage", () => {
  it("turns an OpenAI completion into a Claude message, cached tokens taken out of input", () => {
    const msg = openAiResponseToClaude(
      {
        id: "chatcmpl-1",
        choices: [{ message: { content: "Done", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"x":2}' } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
      },
      "claude-sonnet-4-6",
    );
    expect(msg).toMatchObject({
      type: "message",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Done" }, { type: "tool_use", id: "c1", name: "f", input: { x: 2 } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40 },
    });
  });

  it("turns a Claude message into an OpenAI completion, cached tokens put back into the prompt", () => {
    const out = claudeResponseToOpenAi(
      {
        id: "msg_1",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 2 },
      },
      "gpt-5",
      1,
    );
    expect(out).toMatchObject({
      object: "chat.completion",
      model: "gpt-5",
      choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "length" }],
      usage: { prompt_tokens: 42, completion_tokens: 5, total_tokens: 47, prompt_tokens_details: { cached_tokens: 30 } },
    });
  });
});

/** Feed text in awkward pieces, as a network would. */
function feed(t: { push(c: string): string; end(): string }, text: string, size = 7): string {
  let out = "";
  for (let i = 0; i < text.length; i += size) out += t.push(text.slice(i, i + size));
  return out + t.end();
}

const events = (sse: string) =>
  sse
    .split("\n\n")
    .filter(Boolean)
    .map((e) => e.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim())
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d) as Record<string, unknown>);

describe("streams", () => {
  it("reads an OpenAI stream as Claude events, text then a tool call, with usage", () => {
    const chunks = [
      { id: "c", choices: [{ delta: { role: "assistant", content: "" } }] },
      { id: "c", choices: [{ delta: { content: "Hel" } }] },
      { id: "c", choices: [{ delta: { content: "lo" } }] },
      { id: "c", choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: "" } }] } }] },
      { id: "c", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] },
      { id: "c", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" }] },
      { id: "c", choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
    ];
    const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const out = events(feed(new OpenAiToClaudeStream("claude-x"), text));
    expect(out.map((e) => e["type"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(out[5]).toMatchObject({ index: 1, content_block: { type: "tool_use", id: "t1", name: "f" } });
    expect(out[9]).toMatchObject({ delta: { stop_reason: "tool_use" }, usage: { input_tokens: 9, output_tokens: 4 } });
  });

  it("reads a Claude stream as OpenAI chunks, with usage only when the caller asked", () => {
    const claude = [
      { type: "message_start", message: { id: "m1", usage: { input_tokens: 7, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "f", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ];
    const text = claude.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const withUsage = feed(new ClaudeToOpenAiStream("gpt-x", true, 1), text);
    expect(withUsage.endsWith("data: [DONE]\n\n")).toBe(true);
    const chunks = events(withUsage);
    const deltas = chunks.map((c) => (c["choices"] as { delta: unknown; finish_reason: unknown }[])[0]);
    expect(deltas[1]).toMatchObject({ delta: { content: "Hi" } });
    expect(deltas[2]).toMatchObject({ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "f" } }] } });
    expect(deltas[4]).toMatchObject({ finish_reason: "tool_calls" });
    expect(chunks[5]).toMatchObject({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 12 } });
    expect(events(feed(new ClaudeToOpenAiStream("gpt-x", false, 1), text)).some((c) => c["usage"] !== undefined)).toBe(false);
  });
});

describe("open models", () => {
  it("names a model by its endpoint", () => {
    expect(parseOpenModel("open:together/meta-llama/Llama-3.3-70B")).toEqual({ endpoint: "together", model: "meta-llama/Llama-3.3-70B" });
    expect(parseOpenModel("open:nomodel")).toBeUndefined();
    expect(parseOpenModel("gpt-5")).toBeUndefined();
  });

  it("prices exactly below a nanodollar per token, rounding each bucket once", () => {
    const cost = costOfOpen(
      { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 3, cacheReadTokens: 500 },
      { inputPerM: usd("0.88"), outputPerM: usd("0.0015"), cachedInputPerM: usd("0.10") },
    );
    // $0.88/M is 880 nanodollars a token; $0.0015/M is 1.5, so 3 tokens are 4.5 → 5.
    expect(cost).toEqual({ input: 880_000n, output: 5n, cacheWrite: 0n, cacheRead: 50_000n, total: 930_005n });
  });
});
