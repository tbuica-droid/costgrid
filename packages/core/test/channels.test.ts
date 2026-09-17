import { describe, expect, it } from "vitest";
import { findModelPrice, normaliseModelId } from "../src/pricing.js";

describe("channel model ids", () => {
  it("strips Bedrock's vendor namespace and version suffix", () => {
    expect(normaliseModelId("anthropic.claude-opus-4-5-20260101-v1:0")).toBe(
      "claude-opus-4-5-20260101",
    );
  });

  it("strips a cross-region inference profile prefix", () => {
    // us.anthropic.… is the same model reached through a routing profile.
    expect(normaliseModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(normaliseModelId("eu.anthropic.claude-sonnet-5-20260201-v1:0")).toBe(
      "claude-sonnet-5-20260201",
    );
  });

  it("converts Vertex's @-dated snapshot", () => {
    expect(normaliseModelId("claude-opus-4-5@20260101")).toBe("claude-opus-4-5-20260101");
  });

  it("leaves a direct-API id alone", () => {
    expect(normaliseModelId("claude-opus-5")).toBe("claude-opus-5");
    expect(normaliseModelId("gpt-5")).toBe("gpt-5");
  });

  it("prices the same model identically however it arrives", () => {
    const direct = findModelPrice("claude-haiku-4-5");
    expect(direct).toBeDefined();

    for (const id of [
      "anthropic.claude-haiku-4-5-v1:0",
      "us.anthropic.claude-haiku-4-5-v1:0",
      "claude-haiku-4-5@20251001",
    ]) {
      // A model priced on one channel must not silently become unpriced on
      // another — that would report a customer's Bedrock spend as zero.
      expect(findModelPrice(id)?.id).toBe(direct!.id);
    }
  });

  it("still refuses a model it genuinely does not know", () => {
    expect(findModelPrice("anthropic.claude-imaginary-9-v1:0")).toBeUndefined();
    expect(findModelPrice("meta.llama3-70b-instruct-v1:0")).toBeUndefined();
  });

  it("does not mangle an id that merely looks channel-shaped", () => {
    // A future direct model containing a dot must not lose its prefix.
    expect(normaliseModelId("gpt-5.5")).toBe("gpt-5.5");
    expect(findModelPrice("gpt-5.5")?.id).toBe("gpt-5.5");
  });
});
