import { presetFor, toUsdString } from "@costgrid/core";
import { type AuditActor, type SourceKind, type SourceRow, toUtcDay, type User } from "@costgrid/db";
import type { ConsoleRequest } from "./console.js";

/**
 * Reading what the setup screens send, shared by the connect and agent routes.
 *
 * Every body here comes from a browser, so each field is checked by hand
 * before it reaches a repository; a helper returns the value or a message
 * that says what was wrong, never the value back.
 */

const DAY_MS = 86_400_000;
const MAX_NAME = 80;
const MAX_SOURCE_ID = 256;
/** History shown by default: the 90 days a connected key brings in. */
export const DEFAULT_DAYS = 90;
export const CONTROL = /[\u0000-\u001f\u007f]/;

export const by = (user: User): AuditActor => ({ kind: "user", id: user.id, label: user.email });

export function bodyOf(request: ConsoleRequest): Record<string, unknown> {
  const body = request.body;
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** The id from the URL: `_` stands for the account's empty id, and only for the account. */
export function readSourceId(kind: SourceKind, raw: string): string | undefined {
  if (kind === "account") return raw === "_" ? "" : undefined;
  if (raw === "" || raw === "_" || raw.length > MAX_SOURCE_ID || CONTROL.test(raw)) return undefined;
  return raw;
}

/** A name an owner typed: trimmed, on one line, not empty, not too long. */
export function readName(raw: unknown): string | { error: string } {
  if (typeof raw !== "string") return { error: "name must be text" };
  const name = raw.trim();
  if (name === "" || name.length > MAX_NAME || CONTROL.test(name)) {
    return { error: `name must be 1 to ${MAX_NAME} characters on one line` };
  }
  return name;
}

/**
 * A purpose preset, with the catalog's version so a client cannot claim a
 * definition it was not shown. `""` clears it.
 */
export function readPurpose(raw: unknown): { id: string; version?: string } | { error: string } {
  if (typeof raw !== "string") return { error: "purposeId must be text" };
  if (raw === "") return { id: "" };
  const preset = presetFor(raw);
  return preset ? { id: preset.id, version: preset.version } : { error: "unknown purpose" };
}

/** The `?days=` window as UTC days ending today, or why it is not one. */
export function rangeOf(request: ConsoleRequest): { from: string; to: string } | { error: string } {
  const raw = (request.query as Record<string, unknown> | undefined)?.["days"];
  const days = raw === undefined ? DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return { error: "days must be an integer between 1 and 365" };
  }
  const now = Date.now();
  return { from: toUtcDay(now - days * DAY_MS), to: toUtcDay(now) };
}

/** A source as the console shows it. Money as a string, as everywhere on the wire. */
export function sourceView(s: SourceRow) {
  return {
    provider: s.provider,
    kind: s.kind,
    id: s.id,
    parentId: s.parentId,
    label: s.label,
    parentLabel: s.parentLabel,
    agentId: s.agentId,
    shared: s.shared,
    assignedBy: s.assignedBy,
    costUsd: toUsdString(s.costNano, 6),
    firstDay: s.firstDay,
    lastDay: s.lastDay,
  };
}
