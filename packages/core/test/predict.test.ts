import { describe, expect, it } from "vitest";
import { labelTask, NO_EVIDENCE, predictOne, rankModels, readableText, type Candidate } from "../src/index.js";

const user = (content: unknown) => ({ messages: [{ role: "user", content }] });

describe("labelTask", () => {
  it("reads the shape of the request first", () => {
    expect(labelTask("anthropic", { tools: [{ name: "f" }], messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] }] }).kind).toBe("agent-step");
    expect(labelTask("openai", { messages: [{ role: "tool", content: "x" }] }).kind).toBe("agent-step");
    expect(labelTask("openai", { response_format: { type: "json_object" }, messages: [] }).kind).toBe("extract");
  });

  it("then the words of the last user turn", () => {
    expect(labelTask("anthropic", user("Please summarise this report")).kind).toBe("summarise");
    expect(labelTask("anthropic", user("Classify this ticket as billing or technical")).kind).toBe("classify");
    expect(labelTask("anthropic", user([{ type: "text", text: "Fix this:\n```js\nconst a = 1\n```" }])).kind).toBe("code");
    expect(labelTask("anthropic", user("Draft an email to the customer")).kind).toBe("write");
    expect(labelTask("anthropic", user("Compare these two plans")).kind).toBe("analyse");
    expect(labelTask("anthropic", user("What time do you open?")).kind).toBe("answer");
  });

  it("sizes by everything, but reads only the first 4 KB", () => {
    expect(labelTask("anthropic", user("hi")).size).toBe("s");
    expect(labelTask("anthropic", user("x".repeat(30_000))).size).toBe("l");
    // A trigger word past the first 4 KB is not read.
    expect(labelTask("anthropic", user(`${"x ".repeat(3000)} summarise`)).kind).toBe("answer");
    expect(readableText(user("y".repeat(10_000))).length).toBe(4096);
  });
});

const cand = (model: string, tier: Candidate["tier"], over: Partial<Candidate["evidence"]> = {}, estimate?: bigint): Candidate => ({
  model,
  tier,
  evidence: { ...NO_EVIDENCE, ...over },
  ...(estimate !== undefined ? { estimatedCostPerCall: estimate } : {}),
});

describe("predictions", () => {
  it("starts from a weak, labelled tier prior and learns from evidence", () => {
    const fresh = predictOne(cand("m", "mid"), undefined, 1);
    expect(fresh.quality.mean).toBeCloseTo(0.78);
    expect(fresh.prior).toBe("tier prior (mid), not a benchmark");
    expect(fresh.confidence).toBeLessThan(0.5);
    expect(fresh.costBasis).toBe("unknown");

    const learned = predictOne(cand("m", "mid", { met: 10, below: 90, calls: 100, cost: 1_000n, finished: 100 }), undefined, 1);
    expect(learned.quality.mean).toBeLessThan(0.15);
    expect(learned.confidence).toBeGreaterThan(0.8);
    expect(learned).toMatchObject({ costBasis: "measured", costPerCall: 10n, evidence: { calls: 100, judged: 100 } });
  });

  it("costs a finished job as calls per job over the chance of finishing", () => {
    const p = predictOne(cand("m", "mid", { finished: 46, notFinished: 50, calls: 100, cost: 10_000n }), undefined, 2);
    // 100 nanodollars a call × 2 calls, over a 50% chance of finishing.
    expect(p.finish.mean).toBeCloseTo(0.5, 1);
    expect(Number(p.costPerFinishedJob)).toBeGreaterThan(390);
    expect(Number(p.costPerFinishedJob)).toBeLessThan(410);
  });

  it("ranks the cheapest model as good as the current one first, and plays safe", () => {
    const ranked = rankModels(
      [
        cand("current", "frontier", { met: 40, below: 0, finished: 40, calls: 40, cost: 40_000n }),
        cand("proven-cheap", "small", { met: 40, below: 0, finished: 40, calls: 40, cost: 4_000n }),
        cand("untested-cheap", "small", {}, 50n),
        cand("worse", "small", { met: 5, below: 35, finished: 40, calls: 40, cost: 400n }),
      ],
      { current: "current" },
    );
    expect(ranked.map((r) => [r.model, r.eligible])).toEqual([
      ["proven-cheap", true],
      ["current", true],
      ["untested-cheap", false],
      ["worse", false],
    ]);
  });

  it("ranks within a budget by quality, and by value when quality has a price", () => {
    const candidates = [
      cand("good-dear", "frontier", { met: 30, finished: 30, calls: 30, cost: 30_000n }),
      cand("ok-cheap", "small", { met: 20, below: 10, finished: 30, calls: 30, cost: 300n }),
    ];
    expect(rankModels(candidates, { mode: { kind: "best-within-budget", budgetPerJob: 500n } })[0]!.model).toBe("ok-cheap");
    expect(rankModels(candidates, { mode: { kind: "best-within-budget", budgetPerJob: 5_000n } })[0]!.model).toBe("good-dear");
    expect(rankModels(candidates, { mode: { kind: "best-value", valueOfFullQuality: 100_000n } })[0]!.model).toBe("good-dear");
    expect(rankModels(candidates, { mode: { kind: "best-value", valueOfFullQuality: 1_000n } })[0]!.model).toBe("ok-cheap");
  });
});
