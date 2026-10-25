import type { Nanodollars } from "./money.js";
import type { Provider } from "./pricing.js";

/**
 * Warnings about risky key setups, from metadata only: what the provider's
 * key lists say about each key (never the key itself), which agent uses each
 * source, and the stored admin keys' expiry and last sync.
 *
 * Pure and ordered, so the same setup always gives the same list. Each
 * warning carries a code and the numbers its sentence needs; the console
 * writes the words. None of these is a breach or a verdict on anyone: each
 * says what could go wrong and the one thing that fixes it.
 */

const DAY_MS = 86_400_000;
/** An active key with no use for this long is one nobody would miss. */
export const UNUSED_KEY_DAYS = 90;
/** A key never used this long after it was made probably never will be. */
export const NEVER_USED_GRACE_DAYS = 30;
/** Keys older than this are due a replacement. */
export const OLD_KEY_DAYS = 365;
/** Providers whose key lists say when each key was last used. */
const REPORTS_LAST_USE: ReadonlySet<Provider> = new Set(["openai"]);
/** Warn this long before a stored admin key stops working. */
export const ADMIN_EXPIRY_NOTICE_DAYS = 14;

export type KeyStatus = "active" | "inactive" | "archived" | "unknown";

/** One API key as the provider's key list describes it. */
export interface KeyFact {
  readonly provider: Provider;
  readonly id: string;
  readonly label: string | null;
  readonly status: KeyStatus;
  readonly createdAt: number | null;
  /** Only OpenAI reports this. */
  readonly lastUsedAt: number | null;
  /** OpenAI: a person's key or a service account's. */
  readonly ownerKind: "user" | "service-account" | null;
  /** Claude: in the Default workspace, which cannot be given its own limits. */
  readonly defaultWorkspace: boolean | null;
}

/** A usage source as the agents screen knows it. */
export interface SourceFact {
  readonly provider: Provider;
  readonly kind: "key" | "workspace" | "project" | "account";
  readonly id: string;
  readonly label: string | null;
  readonly agentId: string | null;
  readonly shared: boolean;
  /** The last UTC day it had usage, YYYY-MM-DD. */
  readonly lastDay: string | null;
  /** Imported cost over the recent window the caller chose. */
  readonly recentCost: Nanodollars;
}

export interface AdminKeyFact {
  readonly provider: Provider;
  readonly expiresAt: number | null;
  readonly lastSyncStatus: "ok" | "error" | null;
}

export const KEY_WARNING_CODES = [
  "admin-key-expired",
  "admin-key-failing",
  "admin-key-expiring",
  "shared-key",
  "unassigned-spend",
  "unused-active-key",
  "account-level-usage",
  "default-workspace-key",
  "personal-key",
  "old-key",
] as const;
export type KeyWarningCode = (typeof KEY_WARNING_CODES)[number];

export type KeyWarningSeverity = "high" | "medium" | "low";

export const SEVERITY_OF: Readonly<Record<KeyWarningCode, KeyWarningSeverity>> = {
  "admin-key-expired": "high",
  "admin-key-failing": "high",
  "admin-key-expiring": "medium",
  "shared-key": "medium",
  "unassigned-spend": "medium",
  "unused-active-key": "medium",
  "account-level-usage": "low",
  "default-workspace-key": "low",
  "personal-key": "low",
  "old-key": "low",
};

export interface KeyWarning {
  readonly code: KeyWarningCode;
  readonly severity: KeyWarningSeverity;
  readonly provider: Provider;
  /** The key, workspace or project it is about; null for an admin key. */
  readonly subject: { readonly kind: SourceFact["kind"]; readonly id: string; readonly label: string | null } | null;
  /** Whole days: until expiry, since last use, or since creation, as the code needs. */
  readonly days?: number;
  readonly recentCost?: Nanodollars;
  /** For an unused key: the provider says it was never used, so `days` is its age. */
  readonly neverUsed?: boolean;
  /** For an unused key: no use seen in `days`, the most CostGrid can see; it may be longer. */
  readonly atLeast?: boolean;
}

const dayEnd = (day: string): number => Date.parse(`${day}T00:00:00Z`) + DAY_MS;
const daysBetween = (from: number, to: number): number => Math.floor((to - from) / DAY_MS);

export function keySafetyWarnings(input: {
  readonly keys: readonly KeyFact[];
  readonly sources: readonly SourceFact[];
  readonly adminKeys: readonly AdminKeyFact[];
  readonly now: number;
}): KeyWarning[] {
  const { now } = input;
  const out: KeyWarning[] = [];
  const add = (w: Omit<KeyWarning, "severity">) => out.push({ ...w, severity: SEVERITY_OF[w.code] });

  for (const admin of input.adminKeys) {
    if (admin.expiresAt !== null && admin.expiresAt <= now) {
      add({ code: "admin-key-expired", provider: admin.provider, subject: null });
    } else if (admin.lastSyncStatus === "error") {
      add({ code: "admin-key-failing", provider: admin.provider, subject: null });
    } else if (admin.expiresAt !== null && admin.expiresAt - now <= ADMIN_EXPIRY_NOTICE_DAYS * DAY_MS) {
      add({ code: "admin-key-expiring", provider: admin.provider, subject: null, days: Math.max(0, Math.ceil((admin.expiresAt - now) / DAY_MS)) });
    }
  }

  const sourceOf = new Map(input.sources.map((s) => [`${s.provider}\u0000${s.kind}\u0000${s.id}`, s]));
  for (const s of input.sources) {
    const subject = { kind: s.kind, id: s.id, label: s.label };
    if (s.shared) add({ code: "shared-key", provider: s.provider, subject });
    else if (s.kind === "account" && s.recentCost > 0n) {
      add({ code: "account-level-usage", provider: s.provider, subject, recentCost: s.recentCost });
    } else if (s.agentId === null && s.recentCost > 0n) {
      add({ code: "unassigned-spend", provider: s.provider, subject, recentCost: s.recentCost });
    }
  }

  for (const k of input.keys) {
    if (k.status !== "active") continue;
    const source = sourceOf.get(`${k.provider}\u0000key\u0000${k.id}`);
    const subject = { kind: "key" as const, id: k.id, label: k.label ?? source?.label ?? null };
    const usedAt = Math.max(k.lastUsedAt ?? -Infinity, source?.lastDay ? dayEnd(source.lastDay) : -Infinity);
    if (Number.isFinite(usedAt)) {
      const idle = daysBetween(usedAt, now);
      if (idle >= UNUSED_KEY_DAYS) add({ code: "unused-active-key", provider: k.provider, subject, days: idle });
    } else if (k.createdAt !== null && REPORTS_LAST_USE.has(k.provider)) {
      const age = daysBetween(k.createdAt, now);
      if (age >= NEVER_USED_GRACE_DAYS) add({ code: "unused-active-key", provider: k.provider, subject, days: age, neverUsed: true });
    } else if (k.createdAt !== null && daysBetween(k.createdAt, now) >= UNUSED_KEY_DAYS) {
      // No last-use date and no usage seen: idle for at least the window imports cover, maybe longer.
      add({ code: "unused-active-key", provider: k.provider, subject, days: UNUSED_KEY_DAYS, atLeast: true });
    }
    if (k.defaultWorkspace === true) add({ code: "default-workspace-key", provider: k.provider, subject });
    if (k.ownerKind === "user") add({ code: "personal-key", provider: k.provider, subject });
    if (k.createdAt !== null && daysBetween(k.createdAt, now) >= OLD_KEY_DAYS) {
      add({ code: "old-key", provider: k.provider, subject, days: daysBetween(k.createdAt, now) });
    }
  }

  const rank = (w: KeyWarning) => KEY_WARNING_CODES.indexOf(w.code);
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return out.sort(
    (a, b) => rank(a) - rank(b) || cmp(a.provider, b.provider) || cmp(a.subject?.id ?? "", b.subject?.id ?? ""),
  );
}
