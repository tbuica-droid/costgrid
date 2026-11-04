import { describe, expect, it } from "vitest";
import { answerOf, checkAnswer } from "../src/index.js";

const json = { format: "json" as const, requiredFields: ["category", "priority"] };

describe("answerOf", () => {
  it("reads Claude text blocks and skips tool calls", () => {
    expect(
      answerOf({ content: [{ type: "text", text: "Hel" }, { type: "tool_use", name: "x" }, { type: "text", text: "lo" }] }),
    ).toEqual({ text: "Hello", refused: false });
  });

  it("reads an OpenAI message and its refusal", () => {
    expect(answerOf({ choices: [{ message: { content: "Hi" } }] })).toEqual({ text: "Hi", refused: false });
    expect(answerOf({ choices: [{ message: { content: null, refusal: "I can't help with that." } }] })).toEqual({
      text: undefined,
      refused: true,
    });
  });
});

describe("checkAnswer", () => {
  it("does not judge a step that asks for a tool", () => {
    expect(checkAnswer({ stopReason: "tool_use", text: "" }, json)).toBeUndefined();
    expect(checkAnswer({ stopReason: "tool_calls", text: undefined })).toBeUndefined();
  });

  it("catches cut-off and refused answers whatever the format", () => {
    expect(checkAnswer({ stopReason: "max_tokens", text: "{" })).toBe("cut-off");
    expect(checkAnswer({ stopReason: "length", text: undefined }, json)).toBe("cut-off");
    expect(checkAnswer({ stopReason: "refusal", text: "" })).toBe("refusal");
    expect(checkAnswer({ stopReason: "stop", text: undefined, refused: true })).toBe("refusal");
    expect(checkAnswer({ stopReason: "content_filter", text: "" })).toBe("refusal");
  });

  it("checks JSON and required fields, fenced or not", () => {
    expect(checkAnswer({ stopReason: "end_turn", text: '{"category":"billing","priority":2}' }, json)).toBe("pass");
    expect(checkAnswer({ stopReason: "end_turn", text: '```json\n{"category":"a","priority":1}\n```' }, json)).toBe("pass");
    expect(checkAnswer({ stopReason: "end_turn", text: '{"category":"a"}' }, json)).toBe("missing-field");
    expect(checkAnswer({ stopReason: "end_turn", text: "[1, 2]" }, json)).toBe("missing-field");
    expect(checkAnswer({ stopReason: "end_turn", text: "Sure! Here it is." }, json)).toBe("not-json");
    expect(checkAnswer({ stopReason: "end_turn", text: "[1]" }, { format: "json" })).toBe("pass");
  });

  it("passes any finished answer when no format is asked for, and never guesses a stream's format", () => {
    expect(checkAnswer({ stopReason: "end_turn", text: "anything" })).toBe("pass");
    expect(checkAnswer({ stopReason: "end_turn", text: undefined }, json)).toBeUndefined();
  });
});
