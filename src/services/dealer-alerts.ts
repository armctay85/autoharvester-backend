import { db } from '../config/database';
import { carListings, dealers } from '../db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { currentMarketMedian, trendForMakeModel } from './trend';

// ─────────────────────────────────────────────────────────────────────────────
//  Dealer "you are $X over market" alert engine
//
//  Powers Dealer Edge ($499/mo) and Inventory IQ ($1,499/mo). For each
//  active dealer-feed listing pinned to a dealer, we compute:
//
//    delta_aud = listing.price − market_median(make, model, year)
//    delta_pct = delta_aud / market_median * 100
//
//  Then classify:
//    over_market_steep   > +8%   — "lower price or your DOM will balloon"
//    over_market_mild    +3..+8% — "consider matching market"
//    on_market           ±3%
//    under_market_mild   −3..−8% — "leaving money on the table"
//    under_market_steep  < −8%   — "sanity-check pricing"
//
//  Plus we attach the model's current trend direction so the recommendation
//  can be tilted (e.g. "market is upswinging — you can hold on price 2 weeks").
// ─────────────────────────────────────────────────────────────────────────────

export type AlertBand =
  | 'over_market_steep'
  | 'over_market_mild'
  | 'on_market'
  | 'under_market_mild'
  | 'under_market_steep'
  | 'unknown';

export interface DealerAlert {
  listingId: string;
  externalId: string;
  make: string;
  model: string;
  year: number;
  listingPriceAud: number;
  marketMedianAud: number | null;
  deltaAud: number | null;
  deltaPct: number | null;
  band: AlertBand;
  trendDirection: string;
  trendVelocityPctPerMonth: number | null;
  recommendation: string;
}

function bandFor(deltaPct: number | null): AlertBand {
  if (deltaPct == null) return 'unknown';
  if (deltaPct > 8)   return 'over_market_steep';
  if (deltaPct > 3)   return 'over_market_mild';
  if (deltaPct < -8)  return 'under_market_steep';
  if (deltaPct < -3)  return 'under_market_mild';
  return 'on_market';
}

function recommendationFor(band: AlertBand, trendDir: string): string {
  switch (band) {
    case 'over_market_steep':
      return trendDir === 'upswing'
        ? 'Listed well above market but model is upswinging — drop ~5% if no leads in 14 days.'
        : 'Listed well above market — drop price 5–8% to avoid days-on-market climbing past 60.';
    case 'over_market_mild':
      return trendDir === 'upswing'
        ? 'Slightly above market in a rising segment — hold for 7–10 days.'
        : 'Slightly above market — match median to accelerate sale.';
    case 'on_market':
      return 'Priced in line with the market — typical days-on-market expected.';
    case 'under_market_mild':
      return 'Below market — review for known issues before lifting price.';
    case 'under_market_steep':
      return 'Significantly below market — verify the listing isn\'t missing equipment, history, or detail.';
    default:
      return 'Insufficient comparable data to classify pricing.';
  }
}

/**
 * Compute pricing alerts for a single dealer's active feed listings.
 *
 * Designed to be called on a cron (e.g. every 6h) and the resulting
 * `DealerAlert[]` shipped via the email + dashboard tile system.
 */
export async function alertsForDealer(dealerId: string): Promise<DealerAlert[]> {
  const rows = await db
    .select({
      id: carListings.id,
      external_id: carListings.external_id,
      make: carListings.make,
      model: carListings.model,
      year: carListings.year,
      price: carListings.price,
    })
    .from(carListings)
    .where(
      and(
        eq(carListings.source_dealer_id, dealerId),
        eq(carListings.is_active, true),
        isNotNull(carListings.price)
      )
    );

  const out: DealerAlert[] = [];
  for (const r of rows) {
    if (r.price == null) continue;
    const market = await currentMarketMedian(r.make, r.model, r.year);
    const trend = await trendForMakeModel(r.make, r.model, r.year, 180);
    const deltaAud = market != null ? r.price - market : null;
    const deltaPct = market != null && market > 0 && deltaAud != null
      ? Number(((deltaAud / market) * 100).toFixed(1))
      : null;
    const band = bandFor(deltaPct);
    out.push({
      listingId: r.id,
      externalId: r.external_id,
      make: r.make,
      model: r.model,
      year: r.year,
      listingPriceAud: r.price,
      marketMedianAud: market,
      deltaAud,
      deltaPct,
      band,
      trendDirection: trend.direction,
      trendVelocityPctPerMonth: trend.velocityPctPerMonth,
      recommendation: recommendationFor(band, trend.direction),
    });
  }
  // Sort: most actionable first (steep over → steep under → mild over → ...)
  const order: Record<AlertBand, number> = {
    over_market_steep: 0,
    under_market_steep: 1,
    over_market_mild: 2,
    under_market_mild: 3,
    on_market: 4,
    unknown: 5,
  };
  out.sort((a, b) => order[a.band] - order[b.band]);
  return out;
}

/**
 * Cron entrypoint — sweep every dealer with `feed_active=true` and produce
 * a per-dealer alert summary. Returns the aggregated payload so the cron
 * runner can decide whether to email / push / persist.
 */
export async function sweepAllActiveDealers(): Promise<
  Array<{ dealerId: string; businessName: string; alerts: DealerAlert[]; counts: Record<AlertBand, number> }>
> {
  const activeDealers = await db
    .select({ id: dealers.id, name: dealers.business_name })
    .from(dealers)
    .where(eq(dealers.feed_active, true));

  const summaries: Array<{
    dealerId: string;
    businessName: string;
    alerts: DealerAlert[];
    counts: Record<AlertBand, number>;
  }> = [];
  for (const d of activeDealers) {
    const alerts = await alertsForDealer(d.id);
    const counts: Record<AlertBand, number> = {
      over_market_steep: 0,
      over_market_mild: 0,
      on_market: 0,
      under_market_mild: 0,
      under_market_steep: 0,
      unknown: 0,
    };
    for (const a of alerts) counts[a.band]++;
    summaries.push({ dealerId: d.id, businessName: d.name, alerts, counts });
  }
  return summaries;
}
