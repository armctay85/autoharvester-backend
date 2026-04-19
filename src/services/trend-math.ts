// ─────────────────────────────────────────────────────────────────────────────
//  Pure trend / regression math
//
//  Kept dependency-free so unit tests can run without a database, env vars,
//  or any framework boot. The DB-aware helpers in `trend.ts` re-export from
//  here.
// ─────────────────────────────────────────────────────────────────────────────

export interface PricePoint {
  t: number; // ms epoch
  p: number; // price (AUD)
}

export interface TrendResult {
  direction: 'upswing' | 'downswing' | 'flat' | 'insufficient_data';
  velocityPctPerMonth: number | null;
  confidence: number;
  sampleSize: number;
  windowDays: number;
  medianPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

export const EMPTY_TREND: TrendResult = {
  direction: 'insufficient_data',
  velocityPctPerMonth: null,
  confidence: 0,
  sampleSize: 0,
  windowDays: 0,
  medianPrice: null,
  minPrice: null,
  maxPrice: null,
  firstObservedAt: null,
  lastObservedAt: null,
};

export function regressPoints(points: PricePoint[], windowDays = 180): TrendResult {
  if (!points.length) return { ...EMPTY_TREND, windowDays };
  const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;
  const filtered = points
    .filter((p) => Number.isFinite(p.p) && p.p > 0 && p.t >= cutoff)
    .sort((a, b) => a.t - b.t);

  const n = filtered.length;
  if (n < 3) {
    return { ...EMPTY_TREND, sampleSize: n, windowDays };
  }

  const t0 = filtered[0]!.t;
  const xs = filtered.map((p) => (p.t - t0) / (24 * 3600 * 1000));
  const ys = filtered.map((p) => p.p);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const slopePerDay = denX === 0 ? 0 : num / denX;
  const intercept = meanY - slopePerDay * meanX;
  const r2 = denX * denY === 0 ? 0 : (num * num) / (denX * denY);

  const velocityPctPerMonth =
    intercept === 0 ? 0 : Number(((slopePerDay * 30) / intercept * 100).toFixed(2));

  let direction: TrendResult['direction'] = 'flat';
  if (Math.abs(velocityPctPerMonth) >= 0.5) {
    direction = velocityPctPerMonth > 0 ? 'upswing' : 'downswing';
  }

  const sortedY = [...ys].sort((a, b) => a - b);
  const median = sortedY[Math.floor(n / 2)]!;

  return {
    direction,
    velocityPctPerMonth,
    confidence: Number(r2.toFixed(3)),
    sampleSize: n,
    windowDays,
    medianPrice: median,
    minPrice: Math.min(...ys),
    maxPrice: Math.max(...ys),
    firstObservedAt: new Date(filtered[0]!.t).toISOString(),
    lastObservedAt: new Date(filtered[n - 1]!.t).toISOString(),
  };
}
