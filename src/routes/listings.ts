import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  searchListings,
  getListingById,
  getAllMakes,
  getModelsByMake,
} from '../services/listings';
import { apiLimiter, searchLimiter } from '../middleware/rate-limit';
import { asyncHandler } from '../middleware/error-handler';
import { getTierConfig } from '../config/env';

const router = Router();

// Search filters schema
const searchSchema = z.object({
  make: z.string().optional(),
  model: z.string().optional(),
  year_min: z.coerce.number().optional(),
  year_max: z.coerce.number().optional(),
  price_min: z.coerce.number().optional(),
  price_max: z.coerce.number().optional(),
  location: z.string().optional(),
  sold_only: z.coerce.boolean().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  sort_by: z.enum(['price', 'year', 'date']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(),
});

// GET /api/listings/search
router.get(
  '/search',
  apiLimiter,
  searchLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const filters = searchSchema.parse(req.query);
    const userTier = req.user?.subscription_tier || 'free';

    // Check if user can view sold listings
    if (filters.sold_only && userTier === 'free') {
      res.status(403).json({
        error: 'Feature not available',
        message: 'Viewing sold listings requires a Pro subscription',
        upgrade_url: '/pricing',
      });
      return;
    }

    const result = await searchListings(filters, userTier);

    const tierConfig = getTierConfig(userTier);

    res.json({
      ...result,
      tier: userTier,
      features: {
        can_view_sold_prices: tierConfig.canViewSoldPrices,
        can_export: tierConfig.canExportData,
      },
    });
  })
);

// GET /api/listings/makes
router.get(
  '/makes',
  apiLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const makes = await getAllMakes();
    res.json({ makes });
  })
);

// GET /api/listings/models
router.get(
  '/models',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { make } = z.object({ make: z.string().min(1) }).parse(req.query);
    const models = await getModelsByMake(make);
    res.json({ make, models });
  })
);

// GET /api/listings/:id
router.get(
  '/:id',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'ID is required' });
      return;
    }
    
    const userTier = req.user?.subscription_tier || 'free';

    const listing = await getListingById(id, userTier);

    if (!listing) {
      res.status(404).json({ error: 'Listing not found' });
      return;
    }

    const tierConfig = getTierConfig(userTier);

    res.json({
      ...listing,
      tier: userTier,
      features: {
        can_view_sold_prices: tierConfig.canViewSoldPrices,
        can_export: tierConfig.canExportData,
      },
    });
  })
);

export default router;
