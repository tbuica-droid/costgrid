/**
 * Translation between the Claude Messages format and the OpenAI Chat
 * Completions format, so a request written for one can be served by the other.
 *
 * Every mapping is explicit, and anything that cannot be carried faithfully
 * makes the request untranslatable rather than being dropped: a request that
 * asked for extended thinking, cache control or a server tool keeps its own
 * model, and the reason is returned for the decision log. Quietly losing a
 * feature the caller relied on is how a cost saving turns into a bug report.
 *
 * Usage is mapped too, for the caller's benefit only: metering always reads
 * the target's own usage with the target's own parser, so cost stays exact.
 * OpenAI's prompt tokens include cached ones; Claude's input tokens do not.
 *
 * Pure: no I/O. Streams are in translate-stream.ts.
 */

export type WireFormat = "anthropic" | "openai";

/** Where an OpenAI-format request goes: OpenAI itself, or an open-model host. */
export type OpenAiFlavour = "openai" | "open";

export type Translated<T = Json> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly reason: string };

type Json = Record<string, unknown>;

const record = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
const no = (reason: string): Translated<never> => ({ ok: false, reason });

/** Claude request fields that have no OpenAI equivalent. */
const CLAUDE_ONLY = ["thinking", "output_config", "top_k", "mcp_servers", "container", "context_management"];
/** OpenAI request fields that have no Claude equivalent. */
const OPENAI_ONLY = [
  "logprobs",
  "top_logprobs",
  "response_format",
  "audio",
  "modalities",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "reasoning_effort",
  "reasoning",
  "prediction",
  "web_search_options",
];

function hasCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCacheControl);
  const r = record(value);
  if (r === undefined) return false;
  if (r["cache_control"] !== undefined) return true;
  return hasCacheControl(r["content"]);
}

// ----------------------------------------------------------- Claude → OpenAI

function claudeText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const b = record(block);
    if (b?.["type"] !== "text") return undefined;
    parts.push(String(b["text"] ?? ""));
  }
  return parts.join("");
}

/** A Claude user content block as an OpenAI content part, or a reason it can't be. */
function claudePart(block: Json): Translated<Json> {
  if (block["type"] === "text") return { ok: true, body: { type: "text", text: String(block["text"] ?? "") } };
  if (block["type"] === "image") {
    const source = record(block["source"]);
    if (source?.["type"] === "base64") {
      return { ok: true, body: { type: "image_url", image_url: { url: `data:${source["media_type"]};base64,${source["data"]}` } } };
    }
    if (source?.["type"] === "url") return { ok: true, body: { type: "image_url", image_url: { url: source["url"] } } };
  }
  return no(`a ${String(block["type"])} block has no OpenAI equivalent`);
}

/**
 * A Claude Messages request as an OpenAI Chat Completions request for
 * `model`. OpenAI itself takes `max_completion_tokens`; open-model hosts
 * take `max_tokens`.
 */
export function claudeToOpenAi(request: unknown, model: string, flavour: OpenAiFlavour): Translated {
  const req = record(request);
  if (req === undefined) return no("the request is not an object");
  for (const field of CLAUDE_ONLY) if (req[field] !== undefined) return no(`it uses ${field}, which OpenAI-format models do not support`);
  if (hasCacheControl(req["system"]) || hasCacheControl(req["messages"]) || hasCacheControl(req["tools"])) {
    return no("it uses cache control, which only Claude honours");
  }

  const messages: Json[] = [];
  if (req["system"] !== undefined) {
    const system = claudeText(req["system"]);
    if (system === undefined) return no("its system prompt holds something other than text");
    if (system !== "") messages.push({ role: "system", content: system });
  }

  for (const raw of Array.isArray(req["messages"]) ? req["messages"] : []) {
    const m = record(raw);
    if (m === undefined) return no("a message is not an object");
    const role = m["role"];
    const content = m["content"];
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) return no("a message has no content");

    if (role === "assistant") {
      let text = "";
      const calls: Json[] = [];
      for (const block of content.map(record)) {
        if (block?.["type"] === "text") text += String(block["text"] ?? "");
        else if (block?.["type"] === "tool_use") {
          calls.push({
            id: block["id"],
            type: "function",
            function: { name: block["name"], arguments: JSON.stringify(block["input"] ?? {}) },
          });
        } else return no(`an assistant ${String(block?.["type"])} block has no OpenAI equivalent`);
      }
      messages.push({ role: "assistant", content: text === "" ? null : text, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    // A user turn: tool results become their own tool messages, first, as OpenAI expects.
    const parts: Json[] = [];
    for (const block of content.map(record)) {
      if (block === undefined) return no("a content block is not an object");
      if (block["type"] === "tool_result") {
        if (block["is_error"] === true) return no("a tool result marked as an error has no OpenAI equivalent");
        const text = claudeText(block["content"] ?? "");
        if (text === undefined) return no("a tool result holds something other than text");
        messages.push({ role: "tool", tool_call_id: block["tool_use_id"], content: text });
        continue;
      }
      const part = claudePart(block);
      if (!part.ok) return part;
      parts.push(part.body);
    }
    if (parts.length > 0) {
      const onlyText = parts.every((p) => p["type"] === "text");
      messages.push({ role: "user", content: onlyText ? parts.map((p) => p["text"]).join("") : parts });
    }
  }

  const out: Json = { model, messages };
  if (typeof req["max_tokens"] === "number") out[flavour === "openai" ? "max_completion_tokens" : "max_tokens"] = req["max_tokens"];
  for (const key of ["temperature", "top_p", "stream"]) if (req[key] !== undefined) out[key] = req[key];
  if (Array.isArray(req["stop_sequences"])) out["stop"] = req["stop_sequences"];

  if (Array.isArray(req["tools"])) {
    const tools: Json[] = [];
    for (const raw of req["tools"]) {
      const t = record(raw);
      if (t === undefined || (t["type"] !== undefined && t["type"] !== "custom")) {
        return no(`the ${String(t?.["name"] ?? "unnamed")} tool is a Claude server tool`);
      }
      tools.push({
        type: "function",
        function: {
          name: t["name"],
          ...(t["description"] !== undefined ? { description: t["description"] } : {}),
          parameters: t["input_schema"] ?? { type: "object" },
        },
      });
    }
    out["tools"] = tools;
  }
  const choice = record(req["tool_choice"]);
  if (choice !== undefined) {
    const type = choice["type"];
    out["tool_choice"] =
      type === "auto" ? "auto" : type === "any" ? "required" : type === "none" ? "none" : { type: "function", function: { name: choice["name"] } };
    if (choice["disable_parallel_tool_use"] === true) out["parallel_tool_calls"] = false;
  }
  return { ok: true, body: out };
}

// ----------------------------------------------------------- OpenAI → Claude

/** Claude's own default when a request gives none; it requires one. */
export const DEFAULT_MAX_TOKENS = 4096;

function openAiText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const p of content.map(record)) {
    if (p?.["type"] !== "text") return undefined;
    parts.push(String(p["text"] ?? ""));
  }
  return parts.join("");
}

function openAiPart(part: Json): Translated<Json> {
  if (part["type"] === "text") return { ok: true, body: { type: "text", text: String(part["text"] ?? "") } };
  if (part["type"] === "image_url") {
    const url = String(record(part["image_url"])?.["url"] ?? "");
    const data = /^data:([^;]+);base64,(.*)$/s.exec(url);
    return {
      ok: true,
      body: data
        ? { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }
        : { type: "image", source: { type: "url", url } },
    };
  }
  return no(`a ${String(part["type"])} part has no Claude equivalent`);
}

/** An OpenAI Chat Completions request as a Claude Messages request for `model`. */
export function openAiToClaude(request: unknown, model: string): Translated {
  const req = record(request);
  if (req === undefined) return no("the request is not an object");
  for (const field of OPENAI_ONLY) if (req[field] !== undefined) return no(`it uses ${field}, which Claude does not support`);
  if (typeof req["n"] === "number" && req["n"] !== 1) return no("it asks for more than one answer");
  if (typeof req["temperature"] === "number" && req["temperature"] > 1) return no("its temperature is above Claude's maximum of 1");

  const system: string[] = [];
  const messages: Json[] = [];
  /** Consecutive tool results become one user turn, as Claude expects. */
  let toolTurn: Json[] | undefined;

  for (const raw of Array.isArray(req["messages"]) ? req["messages"] : []) {
    const m = record(raw);
    if (m === undefined) return no("a message is not an object");
    const role = m["role"];
    if (role !== "tool") toolTurn = undefined;

    if (role === "system" || role === "developer") {
      const text = openAiText(m["content"]);
      if (text === undefined) return no("a system message holds something other than text");
      system.push(text);
      continue;
    }
    if (role === "tool") {
      const text = openAiText(m["content"]);
      if (text === undefined) return no("a tool result holds something other than text");
      const block = { type: "tool_result", tool_use_id: m["tool_call_id"], content: text };
      if (toolTurn === undefined) {
        toolTurn = [block];
        messages.push({ role: "user", content: toolTurn });
      } else toolTurn.push(block);
      continue;
    }
    if (role === "assistant") {
      const text = openAiText(m["content"]);
      if (text === undefined) return no("an assistant message holds something other than text");
      const blocks: Json[] = text === "" ? [] : [{ type: "text", text }];
      for (const call of Array.isArray(m["tool_calls"]) ? m["tool_calls"].map(record) : []) {
        const fn = record(call?.["function"]);
        if (call?.["type"] !== "function" || fn === undefined) return no("a tool call is not a function call");
        let input: unknown;
        try {
          input = JSON.parse(String(fn["arguments"] ?? "{}"));
        } catch {
          return no("a tool call's arguments are not valid JSON");
        }
        blocks.push({ type: "tool_use", id: call["id"], name: fn["name"], input });
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (role !== "user") return no(`a ${String(role)} message has no Claude equivalent`);
    const content = m["content"];
    if (typeof content === "string") {
      messages.push({ role: "user", content });
      continue;
    }
    if (!Array.isArray(content)) return no("a user message has no content");
    const parts: Json[] = [];
    for (const p of content.map(record)) {
      if (p === undefined) return no("a content part is not an object");
      const part = openAiPart(p);
      if (!part.ok) return part;
      parts.push(part.body);
    }
    messages.push({ role: "user", content: parts });
  }

  const max = req["max_completion_tokens"] ?? req["max_tokens"];
  const out: Json = { model, max_tokens: typeof max === "number" ? max : DEFAULT_MAX_TOKENS, messages };
  if (system.length > 0) out["system"] = system.join("\n\n");
  for (const key of ["temperature", "top_p", "stream"]) if (req[key] !== undefined) out[key] = req[key];
  const stop = req["stop"];
  if (typeof stop === "string") out["stop_sequences"] = [stop];
  else if (Array.isArray(stop)) out["stop_sequences"] = stop;

  if (Array.isArray(req["tools"])) {
    const tools: Json[] = [];
    for (const t of req["tools"].map(record)) {
      const fn = record(t?.["function"]);
      if (t?.["type"] !== "function" || fn === undefined) return no("a tool is not a function");
      tools.push({
        name: fn["name"],
        ...(fn["description"] !== undefined ? { description: fn["description"] } : {}),
        input_schema: fn["parameters"] ?? { type: "object", properties: {} },
      });
    }
    out["tools"] = tools;
  }
  const choice = req["tool_choice"];
  const parallelOff = req["parallel_tool_calls"] === false ? { disable_parallel_tool_use: true } : {};
  if (choice === "auto") out["tool_choice"] = { type: "auto", ...parallelOff };
  else if (choice === "required") out["tool_choice"] = { type: "any", ...parallelOff };
  else if (choice === "none") out["tool_choice"] = { type: "none" };
  else if (record(choice) !== undefined) {
    out["tool_choice"] = { type: "tool", name: record(record(choice)!["function"])?.["name"], ...parallelOff };
  } else if (req["parallel_tool_calls"] === false && out["tools"] !== undefined) out["tool_choice"] = { type: "auto", ...parallelOff };
  return { ok: true, body: out };
}

// ------------------------------------------------------------------ responses

const FINISH_TO_STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};
const STOP_TO_FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
  pause_turn: "stop",
};

export function finishToStop(reason: unknown): string | null {
  return typeof reason === "string" ? (FINISH_TO_STOP[reason] ?? "end_turn") : null;
}

export function stopToFinish(reason: unknown): string | null {
  return typeof reason === "string" ? (STOP_TO_FINISH[reason] ?? "stop") : null;
}

/** OpenAI usage as Claude reports it: input excludes cached tokens. */
export function openAiUsageToClaude(usage: unknown): Json {
  const u = record(usage) ?? {};
  const prompt = Number(u["prompt_tokens"] ?? 0);
  const cached = Number(record(u["prompt_tokens_details"])?.["cached_tokens"] ?? 0);
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: Number(u["completion_tokens"] ?? 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

/** Claude usage as OpenAI reports it: prompt tokens include every cached one. */
export function claudeUsageToOpenAi(usage: unknown): Json {
  const u = record(usage) ?? {};
  const read = Number(u["cache_read_input_tokens"] ?? 0);
  const prompt = Number(u["input_tokens"] ?? 0) + read + Number(u["cache_creation_input_tokens"] ?? 0);
  const completion = Number(u["output_tokens"] ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: read },
  };
}

/** An OpenAI chat completion as a Claude message, under the model name the caller should see. */
export function openAiResponseToClaude(payload: unknown, model: string): Json {
  const p = record(payload) ?? {};
  const choice = record(Array.isArray(p["choices"]) ? p["choices"][0] : undefined) ?? {};
  const message = record(choice["message"]) ?? {};
  const content: Json[] = [];
  if (typeof message["content"] === "string" && message["content"] !== "") content.push({ type: "text", text: message["content"] });
  for (const call of Array.isArray(message["tool_calls"]) ? message["tool_calls"].map(record) : []) {
    const fn = record(call?.["function"]) ?? {};
    let input: unknown = {};
    try {
      input = JSON.parse(String(fn["arguments"] ?? "{}"));
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: call?.["id"], name: fn["name"], input });
  }
  const refused = typeof message["refusal"] === "string" && message["refusal"] !== "";
  if (refused) content.push({ type: "text", text: message["refusal"] });
  return {
    id: p["id"] ?? "msg_costgrid",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: refused ? "refusal" : finishToStop(choice["finish_reason"]),
    stop_sequence: null,
    usage: openAiUsageToClaude(p["usage"]),
  };
}

/** A Claude message as an OpenAI chat completion, under the model name the caller should see. */
export function claudeResponseToOpenAi(payload: unknown, model: string, created = Math.floor(Date.now() / 1000)): Json {
  const p = record(payload) ?? {};
  let text = "";
  const calls: Json[] = [];
  for (const block of Array.isArray(p["content"]) ? p["content"].map(record) : []) {
    if (block?.["type"] === "text") text += String(block["text"] ?? "");
    else if (block?.["type"] === "tool_use") {
      calls.push({ id: block["id"], type: "function", function: { name: block["name"], arguments: JSON.stringify(block["input"] ?? {}) } });
    }
  }
  return {
    id: p["id"] ?? "chatcmpl-costgrid",
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text === "" && calls.length ? null : text, ...(calls.length ? { tool_calls: calls } : {}) },
        finish_reason: stopToFinish(p["stop_reason"]) ?? "stop",
      },
    ],
    usage: claudeUsageToOpenAi(p["usage"]),
  };
}
