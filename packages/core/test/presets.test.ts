import { describe, expect, it } from "vitest";
import { LATEST_PRESET_VERSION, PRESET_HISTORY, PURPOSE_PRESETS, presetFor } from "../src/index.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("purpose presets", () => {
  it("offers the five purposes an owner picks from, in order, at the latest version", () => {
    expect(LATEST_PRESET_VERSION).toBe("2");
    expect(
      PURPOSE_PRESETS.map((p) => [p.id, p.label, p.version, p.evidence, p.maturationWindowMs / DAY_MS, p.reRunWindowMs! / HOUR_MS]),
    ).toEqual([
      ["support", "Customer support", "2", "medium", 7, 24],
      ["sales-leads", "Sales leads", "2", "weak", 14, 48],
      ["content", "Content", "2", "medium", 3, 24],
      ["data-entry", "Data entry", "2", "medium", 1, 2],
      ["other", "Other", "2", "weak", 7, 24],
    ]);
  });

  it("keeps version 1 exactly as it was, so agents set up under it keep its meaning", () => {
    expect(presetFor("support", "1")).toEqual({
      id: "support",
      version: "1",
      label: "Customer support",
      finishedJob: "A ticket is closed and not reopened",
      evidence: "strong",
      maturationWindowMs: 7 * DAY_MS,
    });
    // Version 1 had no detection rules.
    expect(PRESET_HISTORY.filter((p) => p.version === "1").every((p) => p.reRunWindowMs === undefined)).toBe(true);
  });

  it("says what a finished job is for every preset", () => {
    for (const preset of PRESET_HISTORY) expect(preset.finishedJob.length).toBeGreaterThan(10);
  });

  it("finds a preset by id and version, and nothing else", () => {
    expect(presetFor("data-entry")?.version).toBe("2");
    expect(presetFor("data-entry", "1")?.evidence).toBe("strong");
    expect(presetFor("data-entry", "9")).toBeUndefined();
    expect(presetFor("Support")).toBeUndefined();
    expect(presetFor("")).toBeUndefined();
  });
});
