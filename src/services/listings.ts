import { db } from '../config/database';
import { carListings, NewCarListing } from '../db/schema';
import { eq, and, gte, lte, ilike, sql, desc, asc, count } from 'drizzle-orm';
import { AppError } from '../middleware/error-handler';
import { CarListing, PriceHistoryEntry } from '../types';

export interface SearchFilters {
  make?: string;
  model?: string;
  year_min?: number;
  year_max?: number;
  price_min?: number;
  price_max?: number;
  location?: string;
  sold_only?: boolean;
  page?: number;
  limit?: number;
  sort_by?: 'price' | 'year' | 'date';
  sort_order?: 'asc' | 'desc';
}

// Convert database row to CarListing type
const toCarListing = (row: typeof carListings.$inferSelect): CarListing => ({
  id: row.id,
  external_id: row.external_id,
  source: row.source,
  make: row.make,
  model: row.model,
  year: row.year,
  price: row.price,
  price_history: row.price_history as PriceHistoryEntry[],
  sold_price: row.sold_price,
  sold_date: row.sold_date,
  location: row.location || '',
  odometer: row.odometer,
  transmission: row.transmission,
  fuel_type: row.fuel_type,
  body_type: row.body_type,
  listing_url: row.listing_url,
  images: row.images as string[],
  first_seen_at: row.first_seen_at,
  last_seen_at: row.last_seen_at,
  removed_at: row.removed_at,
  is_sold: row.is_sold,
  is_active: row.is_active,
});

// Search listings with filters
export const searchListings = async (
  filters: SearchFilters,
  userTier: string = 'free'
): Promise<{ listings: CarListing[]; total: number; page: number; totalPages: number }> => {
  const page = filters.page || 1;
  const limit = Math.min(filters.limit || 20, 100); // Max 100 per page
  const offset = (page - 1) * limit;

  // Build where conditions
  const conditions: ReturnType<typeof and>[] = [];

  if (filters.make) {
    conditions.push(ilike(carListings.make, `%${filters.make}%`));
  }

  if (filters.model) {
    conditions.push(ilike(carListings.model, `%${filters.model}%`));
  }

  if (filters.year_min) {
    conditions.push(gte(carListings.year, filters.year_min));
  }

  if (filters.year_max) {
    conditions.push(lte(carListings.year, filters.year_max));
  }

  if (filters.price_min) {
    conditions.push(gte(carListings.price, filters.price_min));
  }

  if (filters.price_max) {
    conditions.push(lte(carListings.price, filters.price_max));
  }

  if (filters.location) {
    conditions.push(ilike(carListings.location, `%${filters.location}%`));
  }

  if (filters.sold_only) {
    conditions.push(eq(carListings.is_sold, true));
  }

  // Free users only see active listings
  if (userTier === 'free') {
    conditions.push(eq(carListings.is_active, true));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Get total count
  const countResult = await db
    .select({ value: count() })
    .from(carListings)
    .where(whereClause);
  const total = countResult[0]?.value ?? 0;

  // Determine sort order
  let orderBy;
  const sortOrder = filters.sort_order === 'asc' ? asc : desc;
  
  switch (filters.sort_by) {
    case 'price':
      orderBy = sortOrder(carListings.price);
      break;
    case 'year':
      orderBy = sortOrder(carListings.year);
      break;
    case 'date':
    default:
      orderBy = sortOrder(carListings.last_seen_at);
  }

  // Get listings
  const rows = await db
    .select()
    .from(carListings)
    .where(whereClause)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  // Filter sensitive data for free users
  const listings = rows.map((row) => {
    const listing = toCarListing(row);
    
    // Free users can't see sold prices or full price history
    if (userTier === 'free') {
      return {
        ...listing,
        sold_price: null,
        price_history: [],
      };
    }
    
    return listing;
  });

  return {
    listings,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
};

// Get single listing by ID
export const getListingById = async (
  id: string,
  userTier: string = 'free'
): Promise<CarListing | null> => {
  const row = await db.query.carListings.findFirst({
    where: eq(carListings.id, id),
  });

  if (!row) return null;

  const listing = toCarListing(row);

  // Free users can't see sold prices or full price history
  if (userTier === 'free') {
    return {
      ...listing,
      sold_price: null,
      price_history: [],
    };
  }

  return listing;
};

// Get all unique makes
export const getAllMakes = async (): Promise<string[]> => {
  const result = await db
    .selectDistinct({ make: carListings.make })
    .from(carListings)
    .where(eq(carListings.is_active, true))
    .orderBy(asc(carListings.make));

  return result.map((r) => r.make);
};

// Get models for a specific make
export const getModelsByMake = async (make: string): Promise<string[]> => {
  const result = await db
    .selectDistinct({ model: carListings.model })
    .from(carListings)
    .where(
      and(
        ilike(carListings.make, make),
        eq(carListings.is_active, true)
      )
    )
    .orderBy(asc(carListings.model));

  return result.map((r) => r.model);
};

// Create new listing (admin only)
export const createListing = async (
  data: Omit<NewCarListing, 'id' | 'created_at' | 'updated_at'>
): Promise<CarListing> => {
  const result = await db
    .insert(carListings)
    .values({
      ...data,
      first_seen_at: new Date(),
      last_seen_at: new Date(),
    })
    .returning();

  const row = result[0];
  if (!row) {
    throw new AppError('Failed to create listing', 500, 'CREATE_FAILED');
  }

  return toCarListing(row);
};

// Update listing
export const updateListing = async (
  id: string,
  data: Partial<NewCarListing>
): Promise<CarListing> => {
  const [row] = await db
    .update(carListings)
    .set({
      ...data,
      last_seen_at: new Date(),
    })
    .where(eq(carListings.id, id))
    .returning();

  if (!row) {
    throw new AppError('Listing not found', 404, 'LISTING_NOT_FOUND');
  }

  return toCarListing(row);
};

// Delete listing
export const deleteListing = async (id: string): Promise<void> => {
  const result = await db
    .delete(carListings)
    .where(eq(carListings.id, id));

  if (result.rowCount === 0) {
    throw new AppError('Listing not found', 404, 'LISTING_NOT_FOUND');
  }
};

// Mark listing as sold
export const markListingAsSold = async (
  id: string,
  soldPrice: number
): Promise<CarListing> => {
  const [row] = await db
    .update(carListings)
    .set({
      is_sold: true,
      sold_price: soldPrice,
      sold_date: new Date(),
      is_active: false,
      removed_at: new Date(),
    })
    .where(eq(carListings.id, id))
    .returning();

  if (!row) {
    throw new AppError('Listing not found', 404, 'LISTING_NOT_FOUND');
  }

  return toCarListing(row);
};

// Add price to history
export const addPriceToHistory = async (
  id: string,
  newPrice: number
): Promise<void> => {
  const listing = await db.query.carListings.findFirst({
    where: eq(carListings.id, id),
  });

  if (!listing) {
    throw new AppError('Listing not found', 404, 'LISTING_NOT_FOUND');
  }

  const priceHistory = (listing.price_history || []) as PriceHistoryEntry[];
  priceHistory.push({
    date: new Date().toISOString(),
    price: newPrice,
  });

  await db
    .update(carListings)
    .set({
      price: newPrice,
      price_history: priceHistory,
      last_seen_at: new Date(),
    })
    .where(eq(carListings.id, id));
};

// Get stats for admin dashboard
export const getListingStats = async (): Promise<{
  total: number;
  active: number;
  sold: number;
  bySource: Record<string, number>;
}> => {
  const totalResult = await db
    .select({ value: count() })
    .from(carListings);
  const total = totalResult[0]?.value ?? 0;

  const activeResult = await db
    .select({ value: count() })
    .from(carListings)
    .where(eq(carListings.is_active, true));
  const active = activeResult[0]?.value ?? 0;

  const soldResult = await db
    .select({ value: count() })
    .from(carListings)
    .where(eq(carListings.is_sold, true));
  const sold = soldResult[0]?.value ?? 0;

  // Count by source
  const sourceCounts = await db
    .select({
      source: carListings.source,
      count: count(),
    })
    .from(carListings)
    .groupBy(carListings.source);

  const bySource: Record<string, number> = {};
  sourceCounts.forEach((s) => {
    bySource[s.source] = Number(s.count);
  });

  return {
    total,
    active,
    sold,
    bySource,
  };
};
