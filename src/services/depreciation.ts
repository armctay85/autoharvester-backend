import { trendForMakeModel, currentMarketMedian } from './trend';
import {
  projectDepreciation,
  totalCostOfOwnership,
  type Segment,
  type Curve,
  type TcoInputs,
} from './depreciation-math';

// ─────────────────────────────────────────────────────────────────────────────
//  Depreciation + total cost of ownership (DB-aware wrapper)
//
//  Pure math lives in `depreciation-math.ts`. This module adds the
//  empirical helper that pulls observed market median + trend from the DB.
// ─────────────────────────────────────────────────────────────────────────────

export { projectDepreciation, totalCostOfOwnership };
export type { Segment, Curve, TcoInputs };

/**
 * Empirical depreciation derived from listings the platform has actually
 * observed, sanity-checked against the heuristic curve.
 */
export async function depreciationForModel({
  make,
  model,
  year,
  purchasePrice,
  segment,
  years = 5,
}: {
  make: string;
  model: string;
  year: number;
  purchasePrice?: number;
  segment: Segment;
  years?: number;
}) {
  const market = await currentMarketMedian(make, model, year);
  const trend = await trendForMakeModel(make, model, year, 365);
  const basis = purchasePrice ?? market ?? null;

  const heuristic = basis
    ? projectDepreciation({ purchasePrice: basis, segment, years })
    : null;

  return {
    make,
    model,
    year,
    segment,
    currentMarketMedianAud: market,
    trend,
    purchaseBasisAud: basis,
    heuristic,
    sanityCheck:
      trend.velocityPctPerMonth != null
        ? {
            empiricalAnnualPct: Number((trend.velocityPctPerMonth * 12).toFixed(1)),
            heuristicAnnualPct:
              heuristic && heuristic.schedule[0]
                ? -heuristic.schedule[0].cumulativeLossPct
                : null,
          }
        : null,
  };
}
