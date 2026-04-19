// ─────────────────────────────────────────────────────────────────────────────
//  Pure depreciation + TCO math
//
//  No DB / no env. Unit-testable in isolation.
// ─────────────────────────────────────────────────────────────────────────────

export type Segment =
  | 'mainstream_petrol'
  | 'mainstream_diesel'
  | 'mainstream_hybrid'
  | 'ev_premium'
  | 'ev_mainstream'
  | 'luxury_european'
  | 'luxury_japanese'
  | 'ute_4wd'
  | 'sports_modern'
  | 'classic_appreciating';

export interface Curve {
  yearOneCliff: number;
  decayPerYear: number; // negative = appreciating
}

export const CURVES: Record<Segment, Curve> = {
  mainstream_petrol:    { yearOneCliff: 0.18, decayPerYear: 0.11 },
  mainstream_diesel:    { yearOneCliff: 0.16, decayPerYear: 0.10 },
  mainstream_hybrid:    { yearOneCliff: 0.15, decayPerYear: 0.09 },
  ev_premium:           { yearOneCliff: 0.30, decayPerYear: 0.13 },
  ev_mainstream:        { yearOneCliff: 0.22, decayPerYear: 0.12 },
  luxury_european:      { yearOneCliff: 0.25, decayPerYear: 0.13 },
  luxury_japanese:      { yearOneCliff: 0.18, decayPerYear: 0.09 },
  ute_4wd:              { yearOneCliff: 0.12, decayPerYear: 0.07 },
  sports_modern:        { yearOneCliff: 0.20, decayPerYear: 0.08 },
  classic_appreciating: { yearOneCliff: 0.0,  decayPerYear: -0.025 },
};

export const SEGMENT_DEFAULTS: Record<
  Segment,
  { fuelLitresPer100km: number; insurancePerYear: number; servicingPerYear: number }
> = {
  mainstream_petrol:    { fuelLitresPer100km: 7.5,  insurancePerYear: 1100, servicingPerYear: 650 },
  mainstream_diesel:    { fuelLitresPer100km: 6.5,  insurancePerYear: 1150, servicingPerYear: 750 },
  mainstream_hybrid:    { fuelLitresPer100km: 4.5,  insurancePerYear: 1200, servicingPerYear: 600 },
  ev_premium:           { fuelLitresPer100km: 0,    insurancePerYear: 2200, servicingPerYear: 450 },
  ev_mainstream:        { fuelLitresPer100km: 0,    insurancePerYear: 1500, servicingPerYear: 450 },
  luxury_european:      { fuelLitresPer100km: 9.5,  insurancePerYear: 2400, servicingPerYear: 1800 },
  luxury_japanese:      { fuelLitresPer100km: 8.5,  insurancePerYear: 1600, servicingPerYear: 950 },
  ute_4wd:              { fuelLitresPer100km: 9.0,  insurancePerYear: 1300, servicingPerYear: 850 },
  sports_modern:        { fuelLitresPer100km: 11.0, insurancePerYear: 2800, servicingPerYear: 1500 },
  classic_appreciating: { fuelLitresPer100km: 13.0, insurancePerYear: 1100, servicingPerYear: 2000 },
};

export function projectDepreciation({
  purchasePrice,
  segment,
  years = 5,
  override,
}: {
  purchasePrice: number;
  segment: Segment;
  years?: number;
  override?: Partial<Curve>;
}) {
  const curve = { ...CURVES[segment], ...override };
  const schedule: Array<{
    year: number;
    valueStart: number;
    valueEnd: number;
    annualLoss: number;
    cumulativeLossPct: number;
  }> = [];
  let value = purchasePrice;
  for (let y = 1; y <= years; y++) {
    const start = value;
    const factor = y === 1 ? (1 - curve.yearOneCliff) : Math.exp(-curve.decayPerYear);
    const end = Math.round(start * factor);
    schedule.push({
      year: y,
      valueStart: Math.round(start),
      valueEnd: end,
      annualLoss: Math.round(start - end),
      cumulativeLossPct: Number(((1 - end / purchasePrice) * 100).toFixed(1)),
    });
    value = end;
  }
  return {
    segment,
    curve,
    schedule,
    fiveYearResidualPct: Number(((value / purchasePrice) * 100).toFixed(1)),
  };
}

export interface TcoInputs {
  purchasePrice: number;
  segment: Segment;
  annualKilometres?: number;
  fuelLitresPer100km?: number;
  fuelPricePerLitre?: number;
  insurancePerYear?: number;
  regoPerYear?: number;
  servicingPerYear?: number;
  years?: number;
}

export function totalCostOfOwnership(inputs: TcoInputs) {
  const years = inputs.years ?? 5;
  const km    = inputs.annualKilometres ?? 15_000;
  const def   = SEGMENT_DEFAULTS[inputs.segment];
  const lp100 = inputs.fuelLitresPer100km ?? def.fuelLitresPer100km;
  const fuelPrice = inputs.fuelPricePerLitre ?? 1.95;
  const ins   = inputs.insurancePerYear ?? def.insurancePerYear;
  const rego  = inputs.regoPerYear ?? 850;
  const serv  = inputs.servicingPerYear ?? def.servicingPerYear;

  const dep = projectDepreciation({
    purchasePrice: inputs.purchasePrice,
    segment: inputs.segment,
    years,
  });

  const annualFuel = (km / 100) * lp100 * fuelPrice;
  const yearly = dep.schedule.map((row) => ({
    year: row.year,
    depreciation: row.annualLoss,
    insurance: Math.round(ins),
    rego: Math.round(rego),
    servicing: Math.round(serv),
    fuel: Math.round(annualFuel),
    total: Math.round(row.annualLoss + ins + rego + serv + annualFuel),
  }));

  const totalAud = yearly.reduce((acc, y) => acc + y.total, 0);
  return {
    inputs: {
      ...inputs,
      years,
      annualKilometres: km,
      fuelLitresPer100km: lp100,
      fuelPricePerLitre: fuelPrice,
    },
    yearly,
    totals: {
      years,
      totalAud,
      perYearAud: Math.round(totalAud / years),
      perKmAud: Number((totalAud / (years * km)).toFixed(2)),
    },
    depreciation: dep,
  };
}
