import { describe, expect, it } from "vitest";
import { type MatchableSource, twinOf, twins } from "../src/source-match.js";

/**
 * Matching a Claude key named in a usage file to the same key identified by
 * the admin API. A wrong match would put one job's cost on another, so a
 * pair is made only when nothing else could be meant.
 */

const file = (id: string, parentId: string | null, kind = "key"): MatchableSource => ({
  provider: "anthropic", kind, id, parentId, label: null, parentLabel: null,
});
const api = (id: string, label: string | null, parentLabel: string | null, kind = "key"): MatchableSource => ({
  provider: "anthropic", kind, id, parentId: kind === "key" ? "wrkspc_1" : null, label, parentLabel,
});

describe("twins", () => {
  it("pairs a file's key with the API's key of the same workspace and name", () => {
    const a = file("Support / support-bot", "Support");
    const b = api("apikey_1", "support-bot", "Support");
    const other = api("apikey_2", "lead-scorer", "Sales");
    expect(twins([a, b, other])).toEqual([[a, b]]);
    expect(twinOf(b, [a, b, other])).toBe(a);
    expect(twinOf(other, [a, b, other])).toBeUndefined();
  });

  it("pairs workspaces by name too", () => {
    const a = file("Ops", null, "workspace");
    const b = api("wrkspc_9", "Ops", null, "workspace");
    expect(twins([a, b])).toEqual([[a, b]]);
  });

  it("makes no pair when either side has two candidates", () => {
    const a = file("Support / bot", "Support");
    expect(twins([a, api("apikey_1", "bot", "Support"), api("apikey_2", "bot", "Support")])).toEqual([]);
    // Two files cannot both be the same key either (only possible through a rename).
    const b = api("apikey_1", "bot", "Support");
    expect(twins([a, { ...a, provider: "anthropic" }, b])).toEqual([]);
  });

  it("keeps names with slashes and commas intact", () => {
    const a = file('Main "prod" / Support, EU', 'Main "prod"');
    const b = api("apikey_1", "Support, EU", 'Main "prod"');
    expect(twins([a, b])).toEqual([[a, b]]);
    // The split is by workspace, not by the first " / ".
    expect(twins([file("A / B / C", "A / B"), api("apikey_x", "C", "A / B")])).toHaveLength(1);
  });

  it("leaves keys outside a workspace, OpenAI and unlabelled keys alone", () => {
    expect(twins([file("support-bot", null), api("apikey_1", "support-bot", null)])).toEqual([]);
    expect(twins([file("Support / bot", "Support"), api("apikey_1", null, "Support")])).toEqual([]);
    const openai = { ...file("P / k", "P"), provider: "openai" };
    expect(twins([openai, { ...api("key_1", "k", "P"), provider: "openai" }])).toEqual([]);
  });
});
