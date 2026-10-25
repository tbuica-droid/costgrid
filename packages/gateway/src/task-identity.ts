import { fingerprintOpening, tenantFingerprintKey } from "@costgrid/core";

/**
 * Which job a proxied call belongs to, for outcome detection.
 *
 * The developer can say, with `x-costgrid-task` (a ticket number, an order
 * id). Without it, and unless the organisation turned matching off, the
 * job's first message is turned into a one-way code (`task-fingerprint.ts`
 * in core). The message is read here and nowhere else, held in a local
 * variable for the length of one function call, and never logged or stored.
 */

export const TASK_HEADER = "x-costgrid-task";
/** The same shape as run ids: bounded, and nothing that could be mistaken for markup or a path. */
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface TaskIdentity {
  readonly taskKey?: string;
  readonly taskSource?: "header" | "fingerprint";
  readonly turns?: number;
}

type Message = { role?: unknown; content?: unknown };

function messagesOf(body: unknown): Message[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) ? (messages as Message[]) : undefined;
}

/**
 * The text of the first user message, from an Anthropic Messages body (also
 * what Bedrock and Vertex carry) or an OpenAI Chat Completions body. Text
 * parts only: images, documents and tool results are not part of the code.
 */
export function firstUserText(body: unknown): string | undefined {
  const first = messagesOf(body)?.find((m) => m?.role === "user");
  if (first === undefined) return undefined;
  if (typeof first.content === "string") return first.content;
  if (!Array.isArray(first.content)) return undefined;
  const text = first.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return text === "" ? undefined : text;
}

/** How many messages the request carried: a count, never their content. */
export function turnsOf(body: unknown): number | undefined {
  return messagesOf(body)?.length;
}

export class TaskIdentifier {
  readonly #key: Uint8Array | undefined;
  readonly #enabled: (tenantId: string) => boolean;
  /** Per-organisation keys, derived once each. */
  readonly #tenantKeys = new Map<string, Buffer>();

  constructor(deps: { key: Uint8Array | undefined; enabled: (tenantId: string) => boolean }) {
    this.#key = deps.key;
    this.#enabled = deps.enabled;
  }

  /** Whether this install can make codes at all. */
  get available(): boolean {
    return this.#key !== undefined;
  }

  #keyFor(tenantId: string): Buffer {
    let key = this.#tenantKeys.get(tenantId);
    if (key === undefined) {
      key = tenantFingerprintKey(this.#key!, tenantId);
      this.#tenantKeys.set(tenantId, key);
    }
    return key;
  }

  of(header: string | undefined, body: unknown, tenantId: string): TaskIdentity {
    const turns = turnsOf(body);
    const counted = turns === undefined ? {} : { turns };
    if (header !== undefined && TASK_ID_PATTERN.test(header)) {
      return { taskKey: header, taskSource: "header", ...counted };
    }
    if (this.#key === undefined || !this.#enabled(tenantId)) return counted;
    const opening = firstUserText(body);
    const code = opening === undefined ? undefined : fingerprintOpening(this.#keyFor(tenantId), opening);
    return code === undefined ? counted : { taskKey: code, taskSource: "fingerprint", ...counted };
  }
}
