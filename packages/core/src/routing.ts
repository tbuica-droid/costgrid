/**
 * The routing model: what a fleet's blended cost per million tokens is at a
 * given substitution share, and where the risk-adjusted optimum sits.
 *
 * Unlike the billing path, this is a *forecast*, so it uses ordinary floats.
 * The output is a planning figure with assumption-sized error bars; exact
 * integer arithmetic here would imply a precision the model does not have.
 *
 * Ported from the CostGrid_Token_Cost_Model.xlsx Routing module, with the
 * optimum solved in closed form rather than by the spreadsheet's grid scan.
 */

export interface RoutingAssumptions {
  /** Blended $/MTok of the frontier tier the fleet routes away from. */
  readonly frontierCost: number;
  /** Blended $/MTok of the open-weight floor it routes toward. */
  readonly openCost: number;
  /**
   * Governance and orchestration overhead charged on substituted traffic, as a
   * fraction. Substituting is not free: it buys evals, fallback and review.
   */
  readonly overhead: number;
  /** Scale of the misrouting-risk penalty, as a fraction of frontier cost. */
  readonly riskCoefficient: number;
  /**
   * Convexity of the risk penalty. N=8 encodes the assumption that routing
   * errors are cheap at the margin and very expensive in the tail — this is
   * the single most consequential assumption in the model.
   */
  readonly riskExponent: number;
}

/** Mid-2026 baseline. Every figure is an assumption, not a measurement. */
export const DEFAULT_ASSUMPTIONS: RoutingAssumptions = {
  frontierCost: 10.0,
  openCost: 0.35,
  overhead: 0.15,
  riskCoefficient: 0.46,
  riskExponent: 8,
};

function assertAssumptions(a: RoutingAssumptions): void {
  if (!(a.frontierCost > 0)) throw new RangeError(`frontierCost must be > 0, got ${a.frontierCost}`);
  if (!(a.openCost >= 0)) throw new RangeError(`openCost must be >= 0, got ${a.openCost}`);
  if (!(a.overhead >= 0)) throw new RangeError(`overhead must be >= 0, got ${a.overhead}`);
  if (!(a.riskCoefficient >= 0)) {
    throw new RangeError(`riskCoefficient must be >= 0, got ${a.riskCoefficient}`);
  }
  if (!(a.riskExponent > 1)) {
    throw new RangeError(`riskExponent must be > 1, got ${a.riskExponent}`);
  }
}

/**
 * Blended cost per million tokens at substitution share `s` (0..1).
 *
 * Three terms: what the substituted traffic costs including its overhead,
 * what the un-substituted frontier traffic costs, and the convex penalty for
 * work that was pushed down a tier and should not have been.
 */
export function blendedCost(share: number, a: RoutingAssumptions = DEFAULT_ASSUMPTIONS): number {
  assertAssumptions(a);
  if (!(share >= 0 && share <= 1)) throw new RangeError(`share must be 0..1, got ${share}`);

  const substituted = share * a.openCost * (1 + a.overhead);
  const remaining = (1 - share) * a.frontierCost;
  const riskPenalty = a.riskCoefficient * a.frontierCost * Math.pow(share, a.riskExponent);
  return substituted + remaining + riskPenalty;
}

/**
 * The share at which the marginal token saving equals the marginal risk penalty.
 *
 * Setting the derivative of `blendedCost` to zero gives a closed form:
 *   s* = ((F - O(1+overhead)) / (N·k·F)) ^ (1/(N-1))
 *
 * Returns 0 when substituting is never worthwhile (the open floor, loaded with
 * overhead, already costs at least as much as frontier), and clamps at 1.
 */
export function optimalShare(a: RoutingAssumptions = DEFAULT_ASSUMPTIONS): number {
  assertAssumptions(a);

  const marginalSaving = a.frontierCost - a.openCost * (1 + a.overhead);
  if (marginalSaving <= 0) return 0;
  if (a.riskCoefficient === 0) return 1;

  const denominator = a.riskExponent * a.riskCoefficient * a.frontierCost;
  const ratio = marginalSaving / denominator;
  const share = Math.pow(ratio, 1 / (a.riskExponent - 1));
  return Math.min(1, Math.max(0, share));
}

export interface RoutingPoint {
  readonly share: number;
  readonly blendedCost: number;
}

export interface RoutingAnalysis {
  readonly currentShare: number;
  readonly currentCost: number;
  readonly optimalShare: number;
  readonly optimalCost: number;
  /** Fractional cost reduction available by moving to the optimum, 0..1. */
  readonly savingFraction: number;
  readonly assumptions: RoutingAssumptions;
}

export function analyzeRouting(
  currentShare: number,
  a: RoutingAssumptions = DEFAULT_ASSUMPTIONS,
): RoutingAnalysis {
  const currentCost = blendedCost(currentShare, a);
  const best = optimalShare(a);
  const optimalCost = blendedCost(best, a);

  return {
    currentShare,
    currentCost,
    optimalShare: best,
    optimalCost,
    savingFraction: currentCost > 0 ? (currentCost - optimalCost) / currentCost : 0,
    assumptions: a,
  };
}

/** Sample the cost curve for charting. */
export function costCurve(
  steps = 100,
  a: RoutingAssumptions = DEFAULT_ASSUMPTIONS,
): RoutingPoint[] {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new RangeError(`steps must be a positive integer, got ${steps}`);
  }
  return Array.from({ length: steps + 1 }, (_, i) => {
    const share = i / steps;
    return { share, blendedCost: blendedCost(share, a) };
  });
}
