import { db } from '../config/database';
import { carListings, vehicleCanonical } from '../db/schema';
import { and, eq, gte, ilike, isNotNull, sql } from 'drizzle-orm';
import type { PriceHistoryEntry } from '../types';
import { regressPoints, type PricePoint, type TrendResult } from './trend-math';

// ─────────────────────────────────────────────────────────────────────────────
//  Trend / regression service (DB-aware wrapper)
//
//  Pure math lives in `trend-math.ts` so it can be unit-tested without env
//  vars or a DB. This module adds the DB queries.
// ─────────────────────────────────────────────────────────────────────────────

export { regressPoints };
export type { PricePoint, TrendResult };

/**
 * Pull every observed price point for a canonical vehicle:
 *   - the current `price` of every listing pinned to it (using last_seen_at)
 *   - every `sold_price` (using sold_date)
 *   - every entry in each listing's `price_history` JSONB array
 *
 * Returns the trend over the last `windowDays`.
 */
export async function trendForCanonical(
  canonicalId: string,
  windowDays = 180
): Promise<TrendResult> {
  const rows = await db
    .select({
      price: carListings.price,
      lastSeenAt: carListings.last_seen_at,
      soldPrice: carListings.sold_price,
      soldDate: carListings.sold_date,
      priceHistory: carListings.price_history,
    })
    .from(carListings)
    .where(eq(carListings.vehicle_canonical_id, canonicalId));

  return regressPoints(extractPoints(rows), windowDays);
}

/**
 * Trend for a make/model/year combo when a canonical id isn't known yet
 * (e.g. anonymous "what's the X doing?" queries on the public site).
 *
 * `year` is optional — if omitted, includes ±2 years from `yearCenter`.
 */
export async function trendForMakeModel(
  make: string,
  model: string,
  year: number | null = null,
  windowDays = 180
): Promise<TrendResult> {
  const conditions = [
    ilike(carListings.make, make),
    ilike(carListings.model, model),
  ];
  if (year) {
    conditions.push(gte(carListings.year, year - 2));
    conditions.push(sql`${carListings.year} <= ${year + 2}`);
  }
  const rows = await db
    .select({
      price: carListings.price,
      lastSeenAt: carListings.last_seen_at,
      soldPrice: carListings.sold_price,
      soldDate: carListings.sold_date,
      priceHistory: carListings.price_history,
    })
    .from(carListings)
    .where(and(...conditions));

  return regressPoints(extractPoints(rows), windowDays);
}

type RawRow = {
  price: number | null;
  lastSeenAt: Date;
  soldPrice: number | null;
  soldDate: Date | null;
  priceHistory: unknown;
};

function extractPoints(rows: RawRow[]): PricePoint[] {
  const out: PricePoint[] = [];
  for (const r of rows) {
    if (r.price && r.price > 0 && r.lastSeenAt) {
      out.push({ t: r.lastSeenAt.getTime(), p: r.price });
    }
    if (r.soldPrice && r.soldPrice > 0 && r.soldDate) {
      out.push({ t: r.soldDate.getTime(), p: r.soldPrice });
    }
    const hist = r.priceHistory as PriceHistoryEntry[] | null;
    if (Array.isArray(hist)) {
      for (const h of hist) {
        const t = Date.parse(h.date);
        if (Number.isFinite(t) && Number.isFinite(h.price) && h.price > 0) {
          out.push({ t, p: h.price });
        }
      }
    }
  }
  return out;
}

/**
 * Helper used by the dealer "you are $X over market" engine and by the
 * report generator. Returns the current market median for a model, ignoring
 * sold prices (which lag) and using only the last 90 days of live listings.
 */
export async function currentMarketMedian(
  make: string,
  model: string,
  year: number | null = null
): Promise<number | null> {
  const conditions = [
    ilike(carListings.make, make),
    ilike(carListings.model, model),
    eq(carListings.is_active, true),
    isNotNull(carListings.price),
    gte(carListings.last_seen_at, new Date(Date.now() - 90 * 24 * 3600 * 1000)),
  ];
  if (year) {
    conditions.push(gte(carListings.year, year - 1));
    conditions.push(sql`${carListings.year} <= ${year + 1}`);
  }
  const rows = await db
    .select({ price: carListings.price })
    .from(carListings)
    .where(and(...conditions));

  const prices = rows
    .map((r) => r.price)
    .filter((p): p is number => p !== null && p > 0)
    .sort((a, b) => a - b);
  if (!prices.length) return null;
  return prices[Math.floor(prices.length / 2)]!;
}

// Re-exported so route handlers don't have to import the schema directly.
export { vehicleCanonical, carListings };
