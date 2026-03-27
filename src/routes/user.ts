import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { eq, and, count, desc } from 'drizzle-orm';
import { db } from '../config/database';
import { savedSearches, priceAlerts } from '../db/schema';
import { getUserById, updateUserProfile } from '../services/auth';
import { apiLimiter } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { getTierConfig } from '../config/env';

const router = Router();

// Validation schemas
const updateProfileSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

const savedSearchSchema = z.object({
  name: z.string().min(1).max(255),
  search_params: z.object({
    make: z.string().optional(),
    model: z.string().optional(),
    year_min: z.number().optional(),
    year_max: z.number().optional(),
    price_min: z.number().optional(),
    price_max: z.number().optional(),
    location: z.string().optional(),
    sold_only: z.boolean().optional(),
  }),
});

const priceAlertSchema = z.object({
  make: z.string().optional(),
  model: z.string().optional(),
  year_min: z.number().optional(),
  year_max: z.number().optional(),
  price_max: z.number().optional(),
  location: z.string().optional(),
});

// GET /api/user/profile
router.get(
  '/profile',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await getUserById(req.user!.id);

    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const tier = user.subscription_tier;
    const tierConfig = getTierConfig(tier);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        subscription: {
          tier,
          status: user.subscription_status,
          expires_at: user.subscription_expires_at,
          limits: {
            max_searches: tierConfig.maxSearches,
            max_alerts: tierConfig.maxAlerts,
            can_view_sold: tierConfig.canViewSoldPrices,
            can_export: tierConfig.canExportData,
          },
        },
        created_at: user.created_at,
        last_login_at: user.last_login_at,
      },
    });
  })
);

// PATCH /api/user/profile
router.patch(
  '/profile',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const updates = updateProfileSchema.parse(req.body);

    const user = await updateUserProfile(req.user!.id, updates);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
      },
    });
  })
);

// GET /api/user/saved-searches
router.get(
  '/saved-searches',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const searches = await db.query.savedSearches.findMany({
      where: eq(savedSearches.user_id, req.user!.id),
      orderBy: [desc(savedSearches.created_at)],
    });

    res.json({ searches });
  })
);

// POST /api/user/saved-searches
router.post(
  '/saved-searches',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const data = savedSearchSchema.parse(req.body);

    // Check user's limit
    const existingCountResult = await db
      .select({ value: count() })
      .from(savedSearches)
      .where(eq(savedSearches.user_id, req.user!.id));
    
    const existingCount = existingCountResult[0]?.value ?? 0;

    const tier = req.user!.subscription_tier || 'free';
    const tierConfig = getTierConfig(tier);
    const maxSearches = tierConfig.maxSearches;

    if (Number(existingCount) >= maxSearches) {
      throw new AppError(
        `You have reached the maximum of ${maxSearches} saved searches for your tier`,
        403,
        'LIMIT_REACHED'
      );
    }

    const [search] = await db
      .insert(savedSearches)
      .values({
        user_id: req.user!.id,
        name: data.name,
        search_params: data.search_params,
      })
      .returning();

    res.status(201).json({ search });
  })
);

// DELETE /api/user/saved-searches/:id
router.delete(
  '/saved-searches/:id',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'ID is required' });
      return;
    }

    const result = await db
      .delete(savedSearches)
      .where(
        and(
          eq(savedSearches.id, id),
          eq(savedSearches.user_id, req.user!.id)
        )
      );

    if (result.rowCount === 0) {
      throw new AppError('Saved search not found', 404, 'NOT_FOUND');
    }

    res.json({ message: 'Saved search deleted' });
  })
);

// GET /api/user/price-alerts
router.get(
  '/price-alerts',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const alerts = await db.query.priceAlerts.findMany({
      where: eq(priceAlerts.user_id, req.user!.id),
      orderBy: [desc(priceAlerts.created_at)],
    });

    res.json({ alerts });
  })
);

// POST /api/user/price-alerts
router.post(
  '/price-alerts',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const data = priceAlertSchema.parse(req.body);

    // Check user's limit
    const existingCountResult = await db
      .select({ value: count() })
      .from(priceAlerts)
      .where(
        and(
          eq(priceAlerts.user_id, req.user!.id),
          eq(priceAlerts.is_active, true)
        )
      );
    
    const existingCount = existingCountResult[0]?.value ?? 0;

    const tier = req.user!.subscription_tier || 'free';
    const tierConfig = getTierConfig(tier);
    const maxAlerts = tierConfig.maxAlerts;

    if (Number(existingCount) >= maxAlerts) {
      throw new AppError(
        `You have reached the maximum of ${maxAlerts} price alerts for your tier`,
        403,
        'LIMIT_REACHED'
      );
    }

    const [alert] = await db
      .insert(priceAlerts)
      .values({
        user_id: req.user!.id,
        ...data,
      })
      .returning();

    res.status(201).json({ alert });
  })
);

// DELETE /api/user/price-alerts/:id
router.delete(
  '/price-alerts/:id',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'ID is required' });
      return;
    }

    const result = await db
      .delete(priceAlerts)
      .where(
        and(
          eq(priceAlerts.id, id),
          eq(priceAlerts.user_id, req.user!.id)
        )
      );

    if (result.rowCount === 0) {
      throw new AppError('Price alert not found', 404, 'NOT_FOUND');
    }

    res.json({ message: 'Price alert deleted' });
  })
);

export default router;
