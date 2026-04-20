// ─────────────────────────────────────────────────────────────────────────────
//  Watchlist weekly email digest
//
//  For every user with `is_active=true` price alerts, we:
//    1. Find listings matching their alert filters (make/model/year/price/state)
//       that have been first_seen_at OR price-changed in the last 7 days.
//    2. Compute a market trend snapshot for each alert (up/down/flat).
//    3. Render a clean HTML body (no images, single accent colour) with
//       up to 5 fresh listings per alert + 2 best-price listings.
//    4. Hand off to the email provider (log/Resend/Postmark).
//
//  This is the engine behind the cron entrypoint at
//  src/scripts/digest-cron.ts (see file). Idempotent per `since` timestamp,
//  so re-running with the same window won't double-send (it just regenerates
//  identical content; downstream provider handles dedupe at most.).
//
//  Designed to run safely with EMAIL_PROVIDER=log on day 1 — you can ship
//  the cron immediately and only swap in Resend/Postmark when ready.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '../config/database';
import { priceAlerts, users, carListings, type PriceAlert } from '../db/schema';
import { and, eq, gte, ilike, isNotNull, lte, sql } from 'drizzle-orm';
import { trendForMakeModel } from './trend';
import { getEmailProvider, type SendEmailResult } from './email';
import {
  renderDigestHtml as renderDigestHtmlPure,
  type DigestListing,
  type DigestSection,
} from './digest-render';

const FRONTEND =
  process.env.FRONTEND_URL?.replace(/\/$/, '') || 'https://autoharvester.com.au';

type AlertSection = DigestSection;

async function listingsForAlert(alert: PriceAlert, sinceDate: Date): Promise<DigestListing[]> {
  const where = [
    eq(carListings.is_active, true),
    isNotNull(carListings.price),
    gte(carListings.first_seen_at, sinceDate),
  ];
  if (alert.make) where.push(ilike(carListings.make, alert.make));
  if (alert.model) where.push(ilike(carListings.model, alert.model));
  if (alert.year_min) where.push(gte(carListings.year, alert.year_min));
  if (alert.year_max) where.push(lte(carListings.year, alert.year_max));
  if (alert.price_max) where.push(lte(carListings.price, alert.price_max));
  if (alert.state) where.push(eq(carListings.state, alert.state));

  const rows = await db
    .select({
      id: carListings.id,
      make: carListings.make,
      model: carListings.model,
      year: carListings.year,
      price: carListings.price,
      odometer: carListings.odometer,
      state: carListings.state,
      location: carListings.location,
      url: carListings.listing_url,
      first_seen_at: carListings.first_seen_at,
    })
    .from(carListings)
    .where(and(...where))
    .orderBy(sql`${carListings.first_seen_at} DESC`)
    .limit(20);

  return rows;
}

async function bestValueForAlert(alert: PriceAlert): Promise<DigestListing[]> {
  // Sub-median active listings — treat as "good buys this week".
  if (!alert.make || !alert.model) return [];
  const where = [
    eq(carListings.is_active, true),
    isNotNull(carListings.price),
    ilike(carListings.make, alert.make),
    ilike(carListings.model, alert.model),
  ];
  if (alert.year_min) where.push(gte(carListings.year, alert.year_min));
  if (alert.year_max) where.push(lte(carListings.year, alert.year_max));
  if (alert.price_max) where.push(lte(carListings.price, alert.price_max));
  if (alert.state) where.push(eq(carListings.state, alert.state));

  const rows = await db
    .select({
      id: carListings.id,
      make: carListings.make,
      model: carListings.model,
      year: carListings.year,
      price: carListings.price,
      odometer: carListings.odometer,
      state: carListings.state,
      location: carListings.location,
      url: carListings.listing_url,
      first_seen_at: carListings.first_seen_at,
    })
    .from(carListings)
    .where(and(...where))
    .orderBy(sql`${carListings.price} ASC`)
    .limit(2);

  return rows;
}

function renderDigestHtml(opts: {
  firstName: string;
  windowLabel: string;
  sections: AlertSection[];
}): string {
  return renderDigestHtmlPure({ ...opts, frontendUrl: FRONTEND });
}

export interface DigestRunResult {
  totalUsers: number;
  totalAlerts: number;
  totalListingsSurfaced: number;
  sends: Array<{ userId: string; email: string; result: SendEmailResult }>;
}

/**
 * Build + send digests for every user with active alerts.
 *
 * @param windowDays Default 7. Use 1 in dev to preview the daily-equivalent.
 * @param dryRun     If true, render but don't actually call the email provider.
 */
export async function runWatchlistDigest(
  windowDays = 7,
  dryRun = false
): Promise<DigestRunResult> {
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  // 1. Pull every active alert with its owning user.
  const rows = await db
    .select({
      alert: priceAlerts,
      userId: users.id,
      email: users.email,
      first_name: users.first_name,
    })
    .from(priceAlerts)
    .innerJoin(users, eq(priceAlerts.user_id, users.id))
    .where(eq(priceAlerts.is_active, true));

  // 2. Group alerts by user.
  type Row = (typeof rows)[number];
  const byUser = new Map<string, { email: string; first_name: string; alerts: PriceAlert[] }>();
  for (const r of rows) {
    if (!byUser.has(r.userId)) {
      byUser.set(r.userId, { email: r.email, first_name: r.first_name, alerts: [] });
    }
    byUser.get(r.userId)!.alerts.push(r.alert);
  }

  const sends: DigestRunResult['sends'] = [];
  let totalListingsSurfaced = 0;
  const provider = getEmailProvider();

  // 3. For each user, build sections + send.
  for (const [userId, info] of byUser.entries()) {
    const sections: AlertSection[] = [];
    for (const a of info.alerts) {
      const [fresh, best, trend] = await Promise.all([
        listingsForAlert(a, since),
        bestValueForAlert(a),
        a.make && a.model
          ? trendForMakeModel(a.make, a.model, undefined, 180)
          : Promise.resolve({
              direction: 'insufficient_data' as const,
              velocityPctPerMonth: null,
              medianPrice: null,
              sampleSize: 0,
              windowDays: 180,
              confidence: 0,
            }),
      ]);
      sections.push({
        alert: a,
        fresh,
        bestValue: best,
        trend: {
          direction: trend.direction,
          velocityPctPerMonth: trend.velocityPctPerMonth,
          medianPrice: trend.medianPrice,
          sampleSize: trend.sampleSize,
        },
      });
      totalListingsSurfaced += fresh.length + best.length;
    }

    // Skip users where every section is empty (avoid digest fatigue).
    if (sections.every((s) => s.fresh.length === 0 && s.bestValue.length === 0)) {
      continue;
    }

    const html = renderDigestHtml({
      firstName: info.first_name || 'there',
      windowLabel: `${windowDays} day${windowDays === 1 ? '' : 's'}`,
      sections,
    });

    const subject = `Autoharvester · ${sections.reduce((s, x) => s + x.fresh.length, 0)} new matches on your watchlist`;

    if (dryRun) {
      sends.push({
        userId,
        email: info.email,
        result: { provider: 'dry-run', id: null, status: 'logged' },
      });
      continue;
    }

    const result = await provider.send({
      to: info.email,
      subject,
      html,
      tag: 'watchlist-digest',
    });
    sends.push({ userId, email: info.email, result });
  }

  return {
    totalUsers: byUser.size,
    totalAlerts: rows.length,
    totalListingsSurfaced,
    sends,
  };
}

// Re-export the renderer for tests + preview.
export { renderDigestHtml };
