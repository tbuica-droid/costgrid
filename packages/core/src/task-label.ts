/**
 * What kind of task a request is, from simple signals (v3, D7's fallback).
 *
 * Read in memory before the call is forwarded and never stored: the label is
 * metadata, like a model name, and the words it came from stay in this
 * function. It reads the shape of the request (tools, tool results, a JSON
 * format) and the first 4 KB of the last user turn, so it costs microseconds
 * however long the request is.
 *
 * Coarse on purpose. A label only groups evidence for predictions, and every
 * prediction shows how much evidence it rests on. A small local model can
 * refine it after the answer has gone (see the gateway's task labeller).
 */

export const TASK_KINDS = [
  "answer",
  "chat",
  "summarise",
  "extract",
  "classify",
  "write",
  "code",
  "analyse",
  "agent-step",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export type TaskSize = "s" | "m" | "l";

export interface TaskLabel {
  readonly kind: TaskKind;
  readonly size: TaskSize;
}

/** Characters of the last user turn read for words. The rest is only measured. */
export const LABEL_READ_CHARS = 4096;

type Json = Record<string, unknown>;
const record = (v: unknown): Json | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;

function textOf(content: unknown, budget: { left: number }, collect: string[]): number {
  if (typeof content === "string") {
    if (budget.left > 0) {
      collect.push(content.slice(0, budget.left));
      budget.left -= Math.min(content.length, budget.left);
    }
    return content.length;
  }
  if (!Array.isArray(content)) return 0;
  let length = 0;
  for (const part of content) {
    const p = record(part);
    if (p === undefined) continue;
    if (typeof p["text"] === "string") length += textOf(p["text"], budget, collect);
    else if (p["content"] !== undefined) length += textOf(p["content"], budget, collect);
  }
  return length;
}

/** Ordered: the first rule that matches decides. */
const WORD_RULES: readonly [TaskKind, RegExp][] = [
  ["code", /```|\b(function|class|def|const|import|SELECT|stack trace|refactor|unit test|bug in|compile)\b/i],
  ["summarise", /\b(summar|tl;?dr|key points|recap|condense)/i],
  ["classify", /\b(classif|categori[sz]e|which category|label (this|each)|tag (this|each)|sentiment|is this (spam|urgent))/i],
  ["extract", /\b(extract|pull out|parse|fields?|fill in|as json|in json|structured)\b/i],
  ["write", /\b(write|draft|compose|rewrite|reply to|email|blog|post|letter|copy for|product description)\b/i],
  ["analyse", /\b(analy[sz]e|compare|evaluate|assess|why does|pros and cons|plan|strategy|reason about)\b/i],
];

/** Label a request in either wire format. */
export function labelTask(format: "anthropic" | "openai", body: unknown): TaskLabel {
  const req = record(body) ?? {};
  const messages = Array.isArray(req["messages"]) ? req["messages"].map(record) : [];

  // Everything's length counts toward size; only the last user turn is read.
  let total = 0;
  const ignored = { left: 0 };
  total += textOf(req["system"], ignored, []);
  for (const m of messages) total += textOf(m?.["content"], ignored, []);
  const size: TaskSize = total < 2_000 ? "s" : total < 20_000 ? "m" : "l";

  const last = [...messages].reverse().find((m) => m?.["role"] === "user" || m?.["role"] === "tool");
  const lastContent = last?.["content"];
  const toolResult =
    last?.["role"] === "tool" ||
    (Array.isArray(lastContent) && lastContent.some((b) => record(b)?.["type"] === "tool_result"));
  const hasTools = Array.isArray(req["tools"]) && req["tools"].length > 0;
  if (toolResult) return { kind: "agent-step", size };

  const format_ = record(req["response_format"])?.["type"];
  if (format === "openai" && (format_ === "json_object" || format_ === "json_schema")) return { kind: "extract", size };

  const words: string[] = [];
  textOf(lastContent, { left: LABEL_READ_CHARS }, words);
  const text = words.join(" ");
  for (const [kind, pattern] of WORD_RULES) if (pattern.test(text)) return { kind, size };

  if (hasTools) return { kind: "agent-step", size };
  const turns = messages.filter((m) => m?.["role"] === "user").length;
  return { kind: turns > 2 ? "chat" : "answer", size };
}

/** The words a labeller may read: the first 4 KB of the last user turn. Held in memory only. */
export function readableText(body: unknown): string {
  const messages = Array.isArray(record(body)?.["messages"]) ? (record(body)!["messages"] as unknown[]).map(record) : [];
  const last = [...messages].reverse().find((m) => m?.["role"] === "user");
  const words: string[] = [];
  textOf(last?.["content"], { left: LABEL_READ_CHARS }, words);
  return words.join(" ");
}
