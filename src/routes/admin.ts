import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, desc, count } from 'drizzle-orm';
import { db } from '../config/database';
import { users, carListings } from '../db/schema';
import {
  createListing,
  deleteListing,
  getListingStats,
} from '../services/listings';
import { runWatchlistDigest } from '../services/digest';
import { apiLimiter } from '../middleware/rate-limit';
import { requireAdmin } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error-handler';

const router = Router();

// Validation schemas
const createListingSchema = z.object({
  external_id: z.string().min(1),
  source: z.enum(['carsales', 'gumtree', 'facebook', 'drive']),
  make: z.string().min(1),
  model: z.string().min(1),
  year: z.number().int().min(1900).max(new Date().getFullYear() + 1),
  price: z.number().int().optional(),
  sold_price: z.number().int().optional(),
  sold_date: z.string().datetime().optional(),
  location: z.string().optional(),
  odometer: z.number().int().optional(),
  transmission: z.string().optional(),
  fuel_type: z.string().optional(),
  body_type: z.string().optional(),
  listing_url: z.string().url(),
  images: z.array(z.string().url()).default([]),
  is_sold: z.boolean().default(false),
  is_active: z.boolean().default(true),
});

// GET /api/admin/users
router.get(
  '/users',
  requireAdmin,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;

    const userList = await db.query.users.findMany({
      columns: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        subscription_tier: true,
        subscription_status: true,
        created_at: true,
        last_login_at: true,
      },
      orderBy: [desc(users.created_at)],
      limit,
      offset,
    });

    const countResult = await db.select({ value: count() }).from(users);
    const total = countResult[0]?.value ?? 0;

    res.json({
      users: userList,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(Number(total) / limit),
      },
    });
  })
);

// GET /api/admin/stats
router.get(
  '/stats',
  requireAdmin,
  apiLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    // User stats
    const totalUsersResult = await db.select({ value: count() }).from(users);
    const totalUsers = totalUsersResult[0]?.value ?? 0;

    const proUsersResult = await db
      .select({ value: count() })
      .from(users)
      .where(eq(users.subscription_tier, 'pro'));
    const proUsers = proUsersResult[0]?.value ?? 0;

    const dealerUsersResult = await db
      .select({ value: count() })
      .from(users)
      .where(eq(users.subscription_tier, 'dealer'));
    const dealerUsers = dealerUsersResult[0]?.value ?? 0;

    const enterpriseUsersResult = await db
      .select({ value: count() })
      .from(users)
      .where(eq(users.subscription_tier, 'enterprise'));
    const enterpriseUsers = enterpriseUsersResult[0]?.value ?? 0;

    // Listing stats
    const listingStats = await getListingStats();

    // Recent signups
    const recentSignups = await db.query.users.findMany({
      columns: {
        id: true,
        email: true,
        first_name: true,
        last_name: true,
        subscription_tier: true,
        created_at: true,
      },
      orderBy: [desc(users.created_at)],
      limit: 10,
    });

    res.json({
      users: {
        total: Number(totalUsers),
        by_tier: {
          free: Number(totalUsers) - Number(proUsers) - Number(dealerUsers) - Number(enterpriseUsers),
          pro: Number(proUsers),
          dealer: Number(dealerUsers),
          enterprise: Number(enterpriseUsers),
        },
      },
      listings: listingStats,
      recent_signups: recentSignups,
    });
  })
);

// POST /api/admin/listings (manual entry)
router.post(
  '/listings',
  requireAdmin,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const data = createListingSchema.parse(req.body);

    const listing = await createListing({
      external_id: data.external_id,
      source: data.source,
      make: data.make,
      model: data.model,
      year: data.year,
      price: data.price || null,
      price_history: data.price ? [{ date: new Date().toISOString(), price: data.price }] : [],
      sold_price: data.sold_price || null,
      sold_date: data.sold_date ? new Date(data.sold_date) : null,
      location: data.location || null,
      odometer: data.odometer || null,
      transmission: data.transmission || null,
      fuel_type: data.fuel_type || null,
      body_type: data.body_type || null,
      listing_url: data.listing_url,
      images: data.images,
      is_sold: data.is_sold,
      is_active: data.is_active,
    });

    res.status(201).json({ listing });
  })
);

// DELETE /api/admin/listings/:id
router.delete(
  '/listings/:id',
  requireAdmin,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'ID is required' });
      return;
    }

    await deleteListing(id);

    res.json({ message: 'Listing deleted successfully' });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/admin/digest/run — manual trigger for the watchlist digest
//
//  Mirrors the cron entrypoint at scripts/digest-cron.ts. Useful for QA in
//  staging and for running an ad-hoc digest before official campaigns.
//  Body:
//    { windowDays?: number, dryRun?: boolean }
// ─────────────────────────────────────────────────────────────────────────────

const digestRunSchema = z.object({
  windowDays: z.number().int().min(1).max(60).optional(),
  dryRun: z.boolean().optional(),
});

router.post(
  '/digest/run',
  apiLimiter,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const { windowDays = 7, dryRun = false } = digestRunSchema.parse(req.body ?? {});
    const result = await runWatchlistDigest(windowDays, dryRun);
    res.json({
      windowDays,
      dryRun,
      totalUsers: result.totalUsers,
      totalAlerts: result.totalAlerts,
      totalListingsSurfaced: result.totalListingsSurfaced,
      sends: result.sends.map((s) => ({
        userId: s.userId,
        email: s.email,
        provider: s.result.provider,
        status: s.result.status,
        id: s.result.id,
        error: s.result.error,
      })),
    });
  })
);

export default router;
