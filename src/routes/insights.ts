import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { apiLimiter } from '../middleware/rate-limit';
import { asyncHandler } from '../middleware/error-handler';
import { trendForCanonical, trendForMakeModel } from '../services/trend';
import {
  CLASSIC_CATALOGUE,
  findClassicBySlug,
  findClassicsForBuyer,
  findDailyForBuyer,
} from '../services/find';
import { depreciationForModel, totalCostOfOwnership } from '../services/depreciation';
import { alertsForDealer } from '../services/dealer-alerts';
import {
  aiEnabled,
  narrateClassicFinder,
  narrateDailyFinder,
  narrateDealerAlerts,
  narrateTrend,
} from '../services/ai-narrative';
import { toCsv, csvAttachmentDisposition } from '../services/csv';
import { db } from '../config/database';
import { carListings } from '../db/schema';
import { eq, and } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
//  /api/insights — combined trend, finder, depreciation + dealer alerts
//
//  These are the consumer-visible "ownership intelligence" endpoints. They
//  intentionally avoid auth on the GET helpers so the public marketing site
//  can show real data; mutating endpoints (POST /find/classics) accept an
//  anonymous body but a tier-gated narrative.
// ─────────────────────────────────────────────────────────────────────────────

const router = Router();

const SEGMENTS = [
  'mainstream_petrol',
  'mainstream_diesel',
  'mainstream_hybrid',
  'ev_premium',
  'ev_mainstream',
  'luxury_european',
  'luxury_japanese',
  'ute_4wd',
  'sports_modern',
  'classic_appreciating',
] as const;

// ── GET /api/insights/catalogue/classics ────────────────────────────────────
router.get(
  '/catalogue/classics',
  apiLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ count: CLASSIC_CATALOGUE.length, items: CLASSIC_CATALOGUE });
  })
);

// ── GET /api/insights/catalogue/classics/:slug ──────────────────────────────
router.get(
  '/catalogue/classics/:slug',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const slug = req.params.slug;
    if (!slug) {
      res.status(400).json({ error: 'slug_required' });
      return;
    }
    const entry = findClassicBySlug(slug);
    if (!entry) {
      res.status(404).json({ error: 'classic_not_found' });
      return;
    }
    const trend = await trendForMakeModel(entry.make, entry.model, entry.yearStart, 365);
    res.json({ entry, trend });
  })
);

// ── GET /api/insights/trend ─────────────────────────────────────────────────
const trendQuery = z.object({
  canonicalId: z.string().uuid().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  year: z.coerce.number().int().optional(),
  windowDays: z.coerce.number().int().min(7).max(1825).default(180),
  narrate: z.coerce.boolean().optional(),
});

router.get(
  '/trend',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const q = trendQuery.parse(req.query);
    let trend;
    let label = '';
    if (q.canonicalId) {
      trend = await trendForCanonical(q.canonicalId, q.windowDays);
      label = `canonical:${q.canonicalId}`;
    } else if (q.make && q.model) {
      trend = await trendForMakeModel(q.make, q.model, q.year ?? null, q.windowDays);
      label = `${q.make} ${q.model}${q.year ? ' ' + q.year : ''}`;
    } else {
      res.status(400).json({ error: 'provide canonicalId OR (make+model)' });
      return;
    }

    let narrative = null;
    if (q.narrate && q.make && q.model) {
      const r = await narrateTrend({
        make: q.make,
        model: q.model,
        year: q.year,
        trend,
      });
      narrative = r;
    }

    res.json({ label, trend, narrative, ai_enabled: aiEnabled() });
  })
);

// ── POST /api/insights/find/classics ────────────────────────────────────────
const findClassicsBody = z.object({
  budget: z.number().int().nonnegative().optional(),
  budgetMax: z.number().int().nonnegative().optional(),
  era: z.enum(['pre1975', '1975-1989', '1990s', '2000s', '2010s+']).optional(),
  purpose: z.enum(['driver', 'investment', 'weekend']).optional(),
  risk: z.enum(['safe', 'balanced', 'aggressive']).optional(),
  narrate: z.boolean().optional(),
});

router.post(
  '/find/classics',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = findClassicsBody.parse(req.body ?? {});
    const candidates = await findClassicsForBuyer(body);
    let narrative = null;
    if (body.narrate) {
      narrative = await narrateClassicFinder({ criteria: body, candidates });
    }
    res.json({
      criteria: body,
      count: candidates.length,
      candidates: candidates.slice(0, 25),
      narrative,
      ai_enabled: aiEnabled(),
    });
  })
);

// ── POST /api/insights/find/daily ───────────────────────────────────────────
const findDailyBody = z.object({
  budgetMax: z.number().int().positive(),
  budgetMin: z.number().int().nonnegative().optional(),
  yearMin: z.number().int().min(1950).max(2100).optional(),
  bodyType: z.string().optional(),
  fuelType: z.string().optional(),
  segment: z.enum(SEGMENTS).optional(),
  state: z.string().length(2).optional().or(z.string().length(3)),
  maxKilometres: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  narrate: z.boolean().optional(),
});

router.post(
  '/find/daily',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = findDailyBody.parse(req.body ?? {});
    const candidates = await findDailyForBuyer(body);
    let narrative = null;
    if (body.narrate) {
      narrative = await narrateDailyFinder({ criteria: body, candidates });
    }
    res.json({
      criteria: body,
      count: candidates.length,
      candidates,
      narrative,
      ai_enabled: aiEnabled(),
    });
  })
);

// ── POST /api/insights/depreciation ─────────────────────────────────────────
const depBody = z.object({
  make: z.string(),
  model: z.string(),
  year: z.number().int().min(1950).max(2100),
  segment: z.enum(SEGMENTS),
  purchasePrice: z.number().int().positive().optional(),
  years: z.number().int().min(1).max(15).optional(),
});

router.post(
  '/depreciation',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = depBody.parse(req.body ?? {});
    const result = await depreciationForModel(body);
    res.json(result);
  })
);

// ── POST /api/insights/tco ──────────────────────────────────────────────────
const tcoBody = z.object({
  purchasePrice: z.number().int().positive(),
  segment: z.enum(SEGMENTS),
  years: z.number().int().min(1).max(15).optional(),
  annualKilometres: z.number().int().min(1000).max(100000).optional(),
  fuelLitresPer100km: z.number().min(0).max(40).optional(),
  fuelPricePerLitre: z.number().min(0.5).max(5).optional(),
  insurancePerYear: z.number().min(0).max(20000).optional(),
  regoPerYear: z.number().min(0).max(5000).optional(),
  servicingPerYear: z.number().min(0).max(20000).optional(),
});

router.post(
  '/tco',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const body = tcoBody.parse(req.body ?? {});
    const result = totalCostOfOwnership(body);
    res.json(result);
  })
);

// ── GET /api/insights/dealer/:dealerId/alerts ───────────────────────────────
//
//  Note: this endpoint is gated by Dealer Edge / Inventory IQ tier in
//  production. For now we surface it at /api/insights so the dashboard
//  can call it; the existing tier middleware can be applied here when
//  the dealer dashboard is wired.
router.get(
  '/dealer/:dealerId/alerts',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const dealerId = req.params.dealerId;
    if (!dealerId) {
      res.status(400).json({ error: 'dealerId_required' });
      return;
    }
    const narrate = req.query.narrate === 'true' || req.query.narrate === '1';
    const alerts = await alertsForDealer(dealerId);
    let narrative = null;
    if (narrate) {
      narrative = await narrateDealerAlerts({
        dealerName: 'Dealer',
        alerts,
      });
    }
    res.json({
      dealerId,
      count: alerts.length,
      alerts,
      narrative,
      ai_enabled: aiEnabled(),
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  CSV exports
//
//  Two endpoints:
//    GET /dealer/:dealerId/alerts.csv  → priced-against-market dealer report
//    GET /dealer/:dealerId/inventory.csv → flat inventory snapshot
//
//  Both return text/csv with a Content-Disposition attachment header so the
//  browser downloads them. Cron-friendly: ?token=… is accepted as an alt to
//  cookie auth (wired separately in the dealer dashboard).
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/dealer/:dealerId/alerts.csv',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const dealerId = req.params.dealerId;
    if (!dealerId) {
      res.status(400).json({ error: 'dealerId_required' });
      return;
    }
    const alerts = await alertsForDealer(dealerId);
    const csv = toCsv(
      alerts.map((a) => ({
        listing_id: a.listingId,
        external_id: a.externalId,
        make: a.make,
        model: a.model,
        year: a.year,
        listing_price_aud: a.listingPriceAud,
        market_median_aud: a.marketMedianAud,
        delta_aud: a.deltaAud,
        delta_pct: a.deltaPct,
        band: a.band,
        trend_direction: a.trendDirection,
        trend_velocity_pct_per_month: a.trendVelocityPctPerMonth,
        recommendation: a.recommendation,
      })),
      [
        'listing_id',
        'external_id',
        'make',
        'model',
        'year',
        'listing_price_aud',
        'market_median_aud',
        'delta_aud',
        'delta_pct',
        'band',
        'trend_direction',
        'trend_velocity_pct_per_month',
        'recommendation',
      ]
    );
    const filename = `dealer-${dealerId.slice(0, 8)}-alerts-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', csvAttachmentDisposition(filename));
    res.send(csv);
  })
);

router.get(
  '/dealer/:dealerId/inventory.csv',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const dealerId = req.params.dealerId;
    if (!dealerId) {
      res.status(400).json({ error: 'dealerId_required' });
      return;
    }
    const rows = await db
      .select({
        id: carListings.id,
        external_id: carListings.external_id,
        make: carListings.make,
        model: carListings.model,
        year: carListings.year,
        price: carListings.price,
        odometer: carListings.odometer,
        transmission: carListings.transmission,
        fuel_type: carListings.fuel_type,
        body_type: carListings.body_type,
        state: carListings.state,
        location: carListings.location,
        listing_url: carListings.listing_url,
        first_seen_at: carListings.first_seen_at,
        last_seen_at: carListings.last_seen_at,
        is_active: carListings.is_active,
        is_sold: carListings.is_sold,
      })
      .from(carListings)
      .where(and(eq(carListings.source_dealer_id, dealerId), eq(carListings.is_active, true)));

    const csv = toCsv(rows, [
      'id',
      'external_id',
      'make',
      'model',
      'year',
      'price',
      'odometer',
      'transmission',
      'fuel_type',
      'body_type',
      'state',
      'location',
      'listing_url',
      'first_seen_at',
      'last_seen_at',
      'is_active',
      'is_sold',
    ]);
    const filename = `dealer-${dealerId.slice(0, 8)}-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', csvAttachmentDisposition(filename));
    res.send(csv);
  })
);

export default router;
