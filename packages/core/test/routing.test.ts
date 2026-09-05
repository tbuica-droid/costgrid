import { describe, expect, it } from "vitest";
import {
  analyzeRouting,
  blendedCost,
  costCurve,
  DEFAULT_ASSUMPTIONS,
  optimalShare,
  type RoutingAssumptions,
} from "../src/routing.js";

describe("blendedCost", () => {
  // These three anchors are the self-test values asserted by the original
  // dashboard and the xlsx Routing module. The port must reproduce them.
  it("reproduces the reference values from the spreadsheet model", () => {
    expect(blendedCost(0.15)).toBeCloseTo(8.56, 2);
    expect(blendedCost(0.8253)).toBeCloseTo(3.07, 2);
  });

  it("equals frontier cost at zero substitution", () => {
    expect(blendedCost(0)).toBeCloseTo(DEFAULT_ASSUMPTIONS.frontierCost, 10);
  });

  it("turns back upward past the optimum as the risk penalty dominates", () => {
    const best = optimalShare();
    expect(blendedCost(best)).toBeLessThan(blendedCost(best - 0.05));
    expect(blendedCost(best)).toBeLessThan(blendedCost(best + 0.05));
    expect(blendedCost(1)).toBeGreaterThan(blendedCost(best));
  });

  it("rejects a share outside 0..1", () => {
    expect(() => blendedCost(-0.1)).toThrow(/share must be 0..1/);
    expect(() => blendedCost(1.5)).toThrow(/share must be 0..1/);
  });
});

describe("optimalShare", () => {
  it("matches the spreadsheet's grid-scan optimum of ~82.5%", () => {
    expect(optimalShare()).toBeCloseTo(0.8253, 4);
  });

  it("agrees with a brute-force scan of the same curve", () => {
    let scanBest = 0;
    let scanMin = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 100_000; i++) {
      const share = i / 100_000;
      const cost = blendedCost(share);
      if (cost < scanMin) {
        scanMin = cost;
        scanBest = share;
      }
    }
    expect(optimalShare()).toBeCloseTo(scanBest, 4);
  });

  it("returns zero when the open floor is not actually cheaper", () => {
    const noSaving: RoutingAssumptions = { ...DEFAULT_ASSUMPTIONS, openCost: 10, overhead: 0.15 };
    expect(optimalShare(noSaving)).toBe(0);
  });

  it("goes all the way to the floor when there is no misrouting risk", () => {
    expect(optimalShare({ ...DEFAULT_ASSUMPTIONS, riskCoefficient: 0 })).toBe(1);
  });

  it("moves toward the floor as the open-weight ecosystem matures", () => {
    // The model's stated 2030 direction: k falls, optimal share rises.
    const y2026 = optimalShare({ ...DEFAULT_ASSUMPTIONS, riskCoefficient: 0.46 });
    const y2030 = optimalShare({ ...DEFAULT_ASSUMPTIONS, riskCoefficient: 0.2 });
    expect(y2030).toBeGreaterThan(y2026);
  });

  it("validates its assumptions", () => {
    expect(() => optimalShare({ ...DEFAULT_ASSUMPTIONS, frontierCost: 0 })).toThrow(/frontierCost/);
    expect(() => optimalShare({ ...DEFAULT_ASSUMPTIONS, riskExponent: 1 })).toThrow(/riskExponent/);
  });
});

describe("analyzeRouting", () => {
  it("quantifies the gap between today's routing and the optimum", () => {
    const analysis = analyzeRouting(0.15);

    expect(analysis.optimalShare).toBeCloseTo(0.8253, 4);
    expect(analysis.currentCost).toBeCloseTo(8.56, 2);
    expect(analysis.optimalCost).toBeCloseTo(3.07, 2);
    // The headline claim on the marketing site: ~64% off the token line.
    expect(analysis.savingFraction).toBeGreaterThan(0.6);
    expect(analysis.savingFraction).toBeLessThan(0.7);
  });

  it("reports no saving when already at the optimum", () => {
    const analysis = analyzeRouting(optimalShare());
    expect(analysis.savingFraction).toBeCloseTo(0, 10);
  });
});

describe("costCurve", () => {
  it("samples inclusive endpoints", () => {
    const curve = costCurve(10);
    expect(curve).toHaveLength(11);
    expect(curve[0]?.share).toBe(0);
    expect(curve[10]?.share).toBe(1);
  });

  it("rejects a nonsensical step count", () => {
    expect(() => costCurve(0)).toThrow(/positive integer/);
  });
});
