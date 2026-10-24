import { describe, expect, it } from "vitest";
import { PURPOSE_PRESETS, presetFor } from "../src/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("purpose presets", () => {
  it("offers the five purposes an owner picks from, in order", () => {
    expect(PURPOSE_PRESETS.map((p) => [p.id, p.label, p.evidence, p.maturationWindowMs / DAY_MS])).toEqual([
      ["support", "Customer support", "strong", 7],
      ["sales-leads", "Sales leads", "medium", 14],
      ["content", "Content", "medium", 3],
      ["data-entry", "Data entry", "strong", 1],
      ["other", "Other", "weak", 7],
    ]);
  });

  it("says what a finished job is for every preset, and versions each one", () => {
    for (const preset of PURPOSE_PRESETS) {
      expect(preset.finishedJob.length).toBeGreaterThan(10);
      expect(preset.version).toBe("1");
    }
    expect(presetFor("support")?.finishedJob).toBe("A ticket is closed and not reopened");
  });

  it("finds a preset by id and nothing else", () => {
    expect(presetFor("data-entry")?.label).toBe("Data entry");
    expect(presetFor("Support")).toBeUndefined();
    expect(presetFor("")).toBeUndefined();
  });
});
