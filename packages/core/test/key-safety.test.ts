import { describe, expect, it } from "vitest";
import { type KeyFact, keySafetyWarnings, type SourceFact } from "../src/key-safety.js";
import { usd } from "../src/money.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 25);

const key = (id: string, extra: Partial<KeyFact> = {}): KeyFact => ({
  provider: "anthropic",
  id,
  label: null,
  status: "active",
  createdAt: NOW - 10 * DAY,
  lastUsedAt: null,
  ownerKind: null,
  defaultWorkspace: false,
  ...extra,
});

const source = (id: string, extra: Partial<SourceFact> = {}): SourceFact => ({
  provider: "anthropic",
  kind: "key",
  id,
  label: null,
  agentId: "bot",
  shared: false,
  lastDay: "2026-10-24",
  recentCost: usd("1"),
  ...extra,
});

const codes = (input: Partial<Parameters<typeof keySafetyWarnings>[0]>) =>
  keySafetyWarnings({ keys: [], sources: [], adminKeys: [], now: NOW, ...input }).map((w) => [w.code, w.subject?.id ?? null, w.days ?? null]);

describe("key-safety warnings", () => {
  it("says nothing about a tidy setup", () => {
    expect(codes({ keys: [key("k1")], sources: [source("k1")] })).toEqual([]);
  });

  it("warns about a stored admin key that has stopped, is failing, or stops soon", () => {
    expect(
      codes({
        adminKeys: [
          { provider: "anthropic", expiresAt: NOW, lastSyncStatus: "ok" },
          { provider: "openai", expiresAt: NOW + 14 * DAY, lastSyncStatus: "ok" },
        ],
      }),
    ).toEqual([
      ["admin-key-expired", null, null],
      ["admin-key-expiring", null, 14],
    ]);
    expect(codes({ adminKeys: [{ provider: "openai", expiresAt: NOW + 15 * DAY, lastSyncStatus: "ok" }] })).toEqual([]);
    expect(codes({ adminKeys: [{ provider: "openai", expiresAt: null, lastSyncStatus: "error" }] })).toEqual([
      ["admin-key-failing", null, null],
    ]);
  });

  it("flags shared keys, spend no agent owns, and usage with no breakdown", () => {
    expect(
      codes({
        sources: [
          source("s", { shared: true, agentId: null }),
          source("u", { agentId: null }),
          source("quiet", { agentId: null, recentCost: 0n }),
          source("", { kind: "account", agentId: null }),
        ],
      }),
    ).toEqual([
      ["shared-key", "s", null],
      ["unassigned-spend", "u", null],
      ["account-level-usage", "", null],
    ]);
  });

  it("calls an active key unused after 90 days, from either the provider's date or the last usage", () => {
    const old = NOW - 400 * DAY;
    expect(codes({ keys: [key("a", { createdAt: old, lastUsedAt: NOW - 90 * DAY })] })).toEqual([
      ["unused-active-key", "a", 90],
      ["old-key", "a", 400],
    ]);
    expect(codes({ keys: [key("a", { lastUsedAt: NOW - 89 * DAY })] })).toEqual([]);
    // Usage seen yesterday outweighs an old provider date.
    expect(codes({ keys: [key("a", { lastUsedAt: NOW - 200 * DAY })], sources: [source("a")] })).toEqual([]);
    // OpenAI says when a key was last used, so a key with no date was never used.
    const openai = (extra: Partial<KeyFact>) => key("a", { provider: "openai", ...extra });
    expect(codes({ keys: [openai({ createdAt: NOW - 30 * DAY })] })).toEqual([["unused-active-key", "a", 30]]);
    expect(keySafetyWarnings({ keys: [openai({ createdAt: NOW - 30 * DAY })], sources: [], adminKeys: [], now: NOW })[0]!.neverUsed).toBe(true);
    expect(codes({ keys: [openai({ createdAt: NOW - 29 * DAY })] })).toEqual([]);
    // Claude does not, so a key with no usage seen is idle for at least the 90 days imports cover.
    expect(codes({ keys: [key("a", { createdAt: NOW - 89 * DAY })] })).toEqual([]);
    const claude = keySafetyWarnings({ keys: [key("a", { createdAt: NOW - 300 * DAY })], sources: [], adminKeys: [], now: NOW });
    expect(claude.map((w) => [w.code, w.days, w.atLeast, w.neverUsed])).toEqual([["unused-active-key", 90, true, undefined]]);
    expect(codes({ keys: [key("a", { status: "inactive", createdAt: old })] })).toEqual([]);
  });

  it("notes keys in the default workspace and keys that belong to a person", () => {
    expect(
      codes({
        keys: [key("d", { defaultWorkspace: true }), key("p", { provider: "openai", ownerKind: "user" })],
        sources: [source("d"), source("p", { provider: "openai" })],
      }),
    ).toEqual([
      ["default-workspace-key", "d", null],
      ["personal-key", "p", null],
    ]);
  });

  it("orders by kind of warning, then provider, then key", () => {
    const list = keySafetyWarnings({
      keys: [],
      sources: [source("b", { shared: true }), source("a", { shared: true, provider: "openai" }), source("a", { shared: true })],
      adminKeys: [{ provider: "openai", expiresAt: null, lastSyncStatus: "error" }],
      now: NOW,
    });
    expect(list.map((w) => [w.severity, w.provider, w.subject?.id ?? null])).toEqual([
      ["high", "openai", null],
      ["medium", "anthropic", "a"],
      ["medium", "anthropic", "b"],
      ["medium", "openai", "a"],
    ]);
  });
});
