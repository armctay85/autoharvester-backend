import { db } from '../config/database';
import { carListings } from '../db/schema';
import { and, eq, gte, ilike, isNotNull, lte, sql } from 'drizzle-orm';
import { trendForMakeModel } from './trend';
import type { Segment } from './depreciation';
import { projectDepreciation } from './depreciation';

// ─────────────────────────────────────────────────────────────────────────────
//  "Find a car that fits me" engine
//
//  Two flavours sharing one scoring function:
//
//    A. findClassicsForBuyer({ budget, era, purpose, risk })
//       — uses the curated CLASSIC_CATALOGUE seed (ported from
//         CarSavingsTracker) plus our observed prices to score candidates.
//
//    B. findDailyForBuyer({ budget, useCase, segment, fuelType, body, state })
//       — searches live listings by hard constraints, then ranks by a
//         composite score: value-vs-market, depreciation forecast, trend,
//         and use-case fit.
//
//  The scoring is rule-based and explainable. AI narrative is optional and
//  layered on top via `services/ai-narrative.ts`.
// ─────────────────────────────────────────────────────────────────────────────

// ── Curated classic seed (ported from CarSavingsTracker) ────────────────────
// Slugs are deliberately stable; trend lookups key off (make, model).

export interface ClassicEntry {
  slug: string;
  make: string;
  model: string;
  generation: string | null;
  yearStart: number;
  yearEnd: number;
  category:
    | 'jdm'
    | 'aus_muscle'
    | 'european_gt'
    | 'modern_classic'
    | 'future_classic'
    | 'us_muscle'
    | 'supercar';
  notes: string;
}

export const CLASSIC_CATALOGUE: ClassicEntry[] = [
  // JDM
  { slug: 'nissan-skyline-r32-gtr',  make: 'Nissan',     model: 'Skyline GT-R',           generation: 'R32', yearStart: 1989, yearEnd: 1994, category: 'jdm',           notes: 'Group A homologation; appreciating fast in AU since the 25-yr import rule opened.' },
  { slug: 'nissan-skyline-r33-gtr',  make: 'Nissan',     model: 'Skyline GT-R',           generation: 'R33', yearStart: 1995, yearEnd: 1998, category: 'jdm',           notes: 'Long underrated, recently catching up to R32 comps.' },
  { slug: 'nissan-skyline-r34-gtr',  make: 'Nissan',     model: 'Skyline GT-R',           generation: 'R34', yearStart: 1999, yearEnd: 2002, category: 'jdm',           notes: 'AU 25-yr rule lands 2024–2027; expect strong upswing.' },
  { slug: 'toyota-supra-mk4',        make: 'Toyota',     model: 'Supra',                  generation: 'A80', yearStart: 1993, yearEnd: 2002, category: 'jdm',           notes: '2JZ-GTE; established blue-chip JDM.' },
  { slug: 'mazda-rx7-fd',            make: 'Mazda',      model: 'RX-7',                   generation: 'FD',  yearStart: 1992, yearEnd: 2002, category: 'jdm',           notes: '13B-REW; condition-sensitive; rotary cult premium.' },
  { slug: 'honda-nsx-na1',           make: 'Honda',      model: 'NSX',                    generation: 'NA1', yearStart: 1990, yearEnd: 1997, category: 'jdm',           notes: 'Original AU-delivered cars command premium.' },
  { slug: 'honda-integra-type-r-dc2',make: 'Honda',      model: 'Integra Type R',         generation: 'DC2', yearStart: 1995, yearEnd: 2001, category: 'jdm',           notes: 'Cultivating cult status; track-clean examples scarce.' },
  { slug: 'mitsubishi-evo-vi-tme',   make: 'Mitsubishi', model: 'Lancer Evolution VI Tommi Mäkinen', generation: 'CP9A', yearStart: 1999, yearEnd: 2001, category: 'jdm', notes: 'Limited-run rally homologation; rapidly rising.' },
  { slug: 'subaru-22b-sti',          make: 'Subaru',     model: 'Impreza 22B STI',        generation: 'GC8', yearStart: 1998, yearEnd: 1998, category: 'jdm',           notes: '424-unit halo car; investment-grade.' },

  // Australian muscle
  { slug: 'ford-falcon-gtho-phase3', make: 'Ford',   model: 'Falcon GTHO Phase III', generation: 'XY', yearStart: 1971, yearEnd: 1971, category: 'aus_muscle', notes: 'AU blue-chip; provenance-critical; six-figure baseline.' },
  { slug: 'holden-monaro-hk-gts',    make: 'Holden', model: 'Monaro GTS 327',        generation: 'HK', yearStart: 1968, yearEnd: 1968, category: 'aus_muscle', notes: 'Bathurst winner halo.' },
  { slug: 'holden-torana-lx-ss-a9x', make: 'Holden', model: 'Torana LX SS A9X',      generation: 'LX', yearStart: 1977, yearEnd: 1978, category: 'aus_muscle', notes: 'Brock Bathurst pedigree; verified A9X premium.' },
  { slug: 'ford-falcon-xy-gt',       make: 'Ford',   model: 'Falcon GT',             generation: 'XY', yearStart: 1970, yearEnd: 1972, category: 'aus_muscle', notes: 'Non-HO GT — strong upswing on real GTs.' },
  { slug: 'holden-vl-walkinshaw',    make: 'Holden', model: 'Commodore VL SS Group A SV', generation: 'VL', yearStart: 1988, yearEnd: 1988, category: 'aus_muscle', notes: 'Walkinshaw; 750 units; halo modern AU classic.' },

  // European GT
  { slug: 'porsche-911-964',         make: 'Porsche',       model: '911',           generation: '964',  yearStart: 1989, yearEnd: 1994, category: 'european_gt', notes: 'Last "real" 911 before water-cooled; Carrera RS premium.' },
  { slug: 'porsche-911-993',         make: 'Porsche',       model: '911',           generation: '993',  yearStart: 1994, yearEnd: 1998, category: 'european_gt', notes: 'Last air-cooled; the safe blue-chip.' },
  { slug: 'porsche-911-996-gt3',     make: 'Porsche',       model: '911 GT3',       generation: '996',  yearStart: 1999, yearEnd: 2005, category: 'european_gt', notes: 'Mezger flat-six; rising as 997 GT3 RS comps pull comps up.' },
  { slug: 'bmw-e30-m3',              make: 'BMW',           model: 'M3',            generation: 'E30',  yearStart: 1986, yearEnd: 1991, category: 'european_gt', notes: 'Homologation icon; AU low supply.' },
  { slug: 'bmw-e36-m3',              make: 'BMW',           model: 'M3',            generation: 'E36',  yearStart: 1992, yearEnd: 1999, category: 'european_gt', notes: 'Underrated; clean low-km cars climbing.' },
  { slug: 'bmw-e46-m3-csl',          make: 'BMW',           model: 'M3 CSL',        generation: 'E46',  yearStart: 2003, yearEnd: 2004, category: 'european_gt', notes: '1383-unit run; strong international comp anchor.' },
  { slug: 'mercedes-r129-sl',        make: 'Mercedes-Benz', model: 'SL (R129)',     generation: 'R129', yearStart: 1989, yearEnd: 2002, category: 'european_gt', notes: 'Underpriced GT; condition-led upswing on 500SL/SL55.' },

  // Modern classics
  { slug: 'porsche-997-gt3-rs',      make: 'Porsche', model: '911 GT3 RS', generation: '997.2', yearStart: 2009, yearEnd: 2011, category: 'modern_classic', notes: 'Last manual GT3 RS; investment-grade.' },
  { slug: 'porsche-991-gt3',         make: 'Porsche', model: '911 GT3',    generation: '991.1', yearStart: 2013, yearEnd: 2016, category: 'modern_classic', notes: 'PDK only; recent dip = potential entry point.' },
  { slug: 'audi-r8-v10-gen1',        make: 'Audi',    model: 'R8 V10',     generation: 'Gen1',  yearStart: 2009, yearEnd: 2012, category: 'modern_classic', notes: 'Manual gated examples now collector grade.' },
  { slug: 'lotus-elise-s1',          make: 'Lotus',   model: 'Elise',      generation: 'S1',    yearStart: 1996, yearEnd: 2001, category: 'modern_classic', notes: 'Rover-era purist; strong UK comps.' },
  { slug: 'honda-s2000-ap1',         make: 'Honda',   model: 'S2000',      generation: 'AP1',   yearStart: 1999, yearEnd: 2003, category: 'future_classic', notes: 'F20C; mileage-sensitive market.' },

  // US muscle
  { slug: 'ford-mustang-boss-302-1970', make: 'Ford',      model: 'Mustang Boss 302', generation: '1st', yearStart: 1969, yearEnd: 1970, category: 'us_muscle', notes: 'Trans-Am homologation; verified DSO premium.' },
  { slug: 'chevrolet-corvette-c2',      make: 'Chevrolet', model: 'Corvette',         generation: 'C2',  yearStart: 1963, yearEnd: 1967, category: 'us_muscle', notes: 'Big-block premium; matching numbers critical.' },

  // Supercars
  { slug: 'ferrari-360-modena',         make: 'Ferrari',     model: '360 Modena', generation: 'F131', yearStart: 1999, yearEnd: 2005, category: 'supercar', notes: 'Manual gated Spider/Modena premium.' },
  { slug: 'lamborghini-gallardo-e-gear', make: 'Lamborghini', model: 'Gallardo',  generation: 'Gen1', yearStart: 2003, yearEnd: 2008, category: 'supercar', notes: 'V10 entry; LP560-4 separates from earlier.' },
];

export type Era = 'pre1975' | '1975-1989' | '1990s' | '2000s' | '2010s+';
export type Purpose = 'driver' | 'investment' | 'weekend';
export type RiskAppetite = 'safe' | 'balanced' | 'aggressive';

export function eraOf(m: ClassicEntry): Era {
  const mid = Math.floor((m.yearStart + (m.yearEnd || m.yearStart)) / 2);
  if (mid < 1975) return 'pre1975';
  if (mid < 1990) return '1975-1989';
  if (mid < 2000) return '1990s';
  if (mid < 2010) return '2000s';
  return '2010s+';
}

export interface FindClassicsCriteria {
  budget?: number;       // min budget (AUD)
  budgetMax?: number;    // max budget (AUD)
  era?: Era;
  purpose?: Purpose;
  risk?: RiskAppetite;
}

export interface ClassicCandidate {
  modelId: string;
  make: string;
  model: string;
  generation: string | null;
  yearStart: number;
  yearEnd: number;
  category: ClassicEntry['category'];
  era: Era;
  notes: string;
  inBudget: boolean;
  referencePrice: number | null;
  trend: Awaited<ReturnType<typeof trendForMakeModel>>;
  riskScore: number;
  score: number;
}

/**
 * Rule-based ranker for the curated classic catalogue.
 *
 * For each catalogue entry, we pull observed market trend (median + velocity)
 * from car_listings, score it on velocity + sample confidence − risk + purpose
 * fit, then filter to the buyer's budget and return descending by score.
 */
export async function findClassicsForBuyer(
  c: FindClassicsCriteria
): Promise<ClassicCandidate[]> {
  const max = Number(c.budgetMax || c.budget || 0);
  const min = Number(c.budget && c.budgetMax ? c.budget : 0);

  const results: ClassicCandidate[] = [];

  for (const m of CLASSIC_CATALOGUE) {
    const era = eraOf(m);
    if (c.era && era !== c.era) continue;

    const trend = await trendForMakeModel(m.make, m.model, m.yearStart, 365);
    const ref = trend.medianPrice;
    const budgetSet = !!(min || max);
    const inBudget = budgetSet
      ? ref != null && (!min || ref >= min) && (!max || ref <= max)
      : true;

    const rangePct =
      ref && trend.maxPrice && trend.minPrice
        ? ((trend.maxPrice - trend.minPrice) / ref) * 100
        : null;
    const riskScore = rangePct == null ? 50 : Math.min(100, Math.round(rangePct));

    const purposeBias = (() => {
      if (c.purpose === 'driver')     return m.category === 'jdm' || m.category === 'modern_classic' ? 10 : 0;
      if (c.purpose === 'investment') return m.category === 'aus_muscle' || m.category === 'european_gt' ? 10 : 0;
      if (c.purpose === 'weekend')    return m.category === 'european_gt' || m.category === 'modern_classic' ? 8 : 0;
      return 0;
    })();

    const upBias  = trend.velocityPctPerMonth ? Math.min(30, trend.velocityPctPerMonth * 5) : 0;
    const conf    = (trend.confidence || 0) * 20;
    const riskAdj =
      c.risk === 'aggressive' ? -riskScore * 0.1
      : c.risk === 'safe'      ? -riskScore * 0.4
      : -riskScore * 0.25;
    const score = Number((50 + upBias + conf + riskAdj + purposeBias).toFixed(1));

    if (budgetSet && !inBudget) continue;

    results.push({
      modelId: m.slug,
      make: m.make,
      model: m.model,
      generation: m.generation,
      yearStart: m.yearStart,
      yearEnd: m.yearEnd,
      category: m.category,
      era,
      notes: m.notes,
      inBudget,
      referencePrice: ref,
      trend,
      riskScore,
      score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Daily-driver finder
// ─────────────────────────────────────────────────────────────────────────────

export interface FindDailyCriteria {
  budgetMax: number;
  budgetMin?: number;
  yearMin?: number;
  bodyType?: string;          // 'suv' | 'ute' | 'hatch' | 'sedan' | 'wagon' | etc
  fuelType?: string;          // 'petrol' | 'diesel' | 'hybrid' | 'electric'
  segment?: Segment;          // optional — drives depreciation forecast
  state?: string;             // 'NSW' etc. (matches state column)
  maxKilometres?: number;
  limit?: number;
}

export interface DailyCandidate {
  listingId: string;
  make: string;
  model: string;
  year: number;
  price: number;
  odometer: number | null;
  location: string | null;
  state: string | null;
  bodyType: string | null;
  fuelType: string | null;
  marketDeltaAud: number | null;     // negative = below market
  marketDeltaPct: number | null;
  trendDirection: string;
  trendVelocityPctPerMonth: number | null;
  fiveYearResidualPct: number | null;
  score: number;
}

export async function findDailyForBuyer(c: FindDailyCriteria): Promise<DailyCandidate[]> {
  const limit = Math.min(c.limit ?? 20, 50);
  const conds = [
    eq(carListings.is_active, true),
    isNotNull(carListings.price),
    lte(carListings.price, c.budgetMax),
  ];
  if (c.budgetMin) conds.push(gte(carListings.price, c.budgetMin));
  if (c.yearMin)   conds.push(gte(carListings.year, c.yearMin));
  if (c.bodyType)  conds.push(ilike(carListings.body_type, c.bodyType));
  if (c.fuelType)  conds.push(ilike(carListings.fuel_type, c.fuelType));
  if (c.state)     conds.push(eq(carListings.state, c.state.toUpperCase()));
  if (c.maxKilometres) conds.push(sql`${carListings.odometer} <= ${c.maxKilometres}`);

  const rows = await db
    .select({
      id: carListings.id,
      make: carListings.make,
      model: carListings.model,
      year: carListings.year,
      price: carListings.price,
      odometer: carListings.odometer,
      location: carListings.location,
      state: carListings.state,
      body_type: carListings.body_type,
      fuel_type: carListings.fuel_type,
    })
    .from(carListings)
    .where(and(...conds))
    .limit(limit * 3); // overfetch so scoring can prune

  const out: DailyCandidate[] = [];
  for (const r of rows) {
    if (r.price == null) continue;
    const trend = await trendForMakeModel(r.make, r.model, r.year, 180);
    const market = trend.medianPrice;
    const marketDeltaAud = market != null ? r.price - market : null;
    const marketDeltaPct =
      market && market > 0 && marketDeltaAud != null
        ? Number(((marketDeltaAud / market) * 100).toFixed(1))
        : null;

    let depResidual: number | null = null;
    if (c.segment) {
      const dep = projectDepreciation({
        purchasePrice: r.price,
        segment: c.segment,
        years: 5,
      });
      depResidual = dep.fiveYearResidualPct;
    }

    // Scoring (higher = better deal):
    //   value:  reward being below market (each −1% market = +1 point, capped)
    //   trend:  reward upswing (good for resale)
    //   resale: reward higher 5yr residual
    const valueScore = marketDeltaPct == null ? 0 : Math.max(-25, Math.min(25, -marketDeltaPct));
    const trendScore = trend.velocityPctPerMonth == null ? 0 : Math.max(-15, Math.min(15, trend.velocityPctPerMonth * 3));
    const residualScore = depResidual == null ? 0 : (depResidual - 50) * 0.3; // 50% residual = 0
    const score = Number((50 + valueScore + trendScore + residualScore).toFixed(1));

    out.push({
      listingId: r.id,
      make: r.make,
      model: r.model,
      year: r.year,
      price: r.price,
      odometer: r.odometer,
      location: r.location,
      state: r.state,
      bodyType: r.body_type,
      fuelType: r.fuel_type,
      marketDeltaAud,
      marketDeltaPct,
      trendDirection: trend.direction,
      trendVelocityPctPerMonth: trend.velocityPctPerMonth,
      fiveYearResidualPct: depResidual,
      score,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

export function findClassicBySlug(slug: string): ClassicEntry | null {
  return CLASSIC_CATALOGUE.find((m) => m.slug === slug) ?? null;
}
