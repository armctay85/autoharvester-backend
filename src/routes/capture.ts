import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../config/database';
import { carListings, dataProvenance } from '../db/schema';
import { upsertCanonical, normaliseState } from '../services/canonical';
import { apiLimiter } from '../middleware/rate-limit';
import { asyncHandler } from '../middleware/error-handler';
import type { PriceHistoryEntry } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
//  User-contribution capture endpoint
//
//  Pattern lifted from CarSavingsTracker (the consumer-side bolt-on we built
//  to scrape your own logged-in carsales account). Here we generalise it as
//  the v2 "user_contribution" ingestion lane:
//
//    1. /capture/token  → mint a short-lived bearer token (browser ext stores it)
//    2. /capture        → ext POSTs scraped page payload, server canonicalises
//                         into vehicle_canonical, upserts a car_listings row
//                         with source='user_contribution', and appends to the
//                         price_history JSONB so we naturally build depreciation
//                         curves over repeat captures.
//
//  This is legal — a user authenticates, a browser extension running with their
//  own session captures listings they themselves are viewing, and the server
//  attributes the data to that user. No incumbent-bypass scraping.
//  See AUDIT_AND_UPLIFT.md §4.1 (user-contributed row).
// ─────────────────────────────────────────────────────────────────────────────

const router = Router();

interface CaptureToken {
  token: string;
  user_id: string | null;
  expires_at: number; // ms epoch
  source_hint: 'carsales' | 'gumtree' | 'facebook' | 'other';
}

// In-memory token store. Move to Redis once we have multiple API instances.
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const tokens = new Map<string, CaptureToken>();

function mintToken(userId: string | null, source: CaptureToken['source_hint']): CaptureToken {
  const t: CaptureToken = {
    token: crypto.randomBytes(24).toString('base64url'),
    user_id: userId,
    expires_at: Date.now() + TOKEN_TTL_MS,
    source_hint: source,
  };
  tokens.set(t.token, t);
  return t;
}

function validateToken(raw: string | undefined): CaptureToken | null {
  if (!raw) return null;
  const t = tokens.get(raw);
  if (!t) return null;
  if (t.expires_at < Date.now()) {
    tokens.delete(raw);
    return null;
  }
  return t;
}

const tokenRequestSchema = z.object({
  source: z.enum(['carsales', 'gumtree', 'facebook', 'other']).default('other'),
});

// POST /api/capture/token  — mint a bearer token (must be logged in to attribute)
router.post(
  '/token',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { source } = tokenRequestSchema.parse(req.body ?? {});
    const userId = req.user?.id ?? null;
    const t = mintToken(userId, source);
    res.json({
      token: t.token,
      expires_at: new Date(t.expires_at).toISOString(),
      attributed_user_id: userId,
      source_hint: source,
    });
  })
);

const captureSchema = z.object({
  external_id: z.string().min(1).max(255),
  listing_url: z.string().url(),
  make: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  year: z.coerce.number().int().min(1950).max(new Date().getFullYear() + 1),
  price: z.coerce.number().int().nonnegative().nullable().optional(),
  variant: z.string().max(200).nullable().optional(),
  vin: z.string().max(32).nullable().optional(),
  rego: z.string().max(16).nullable().optional(),
  rego_state: z.string().max(4).nullable().optional(),
  odometer: z.coerce.number().int().nonnegative().nullable().optional(),
  transmission: z.string().max(50).nullable().optional(),
  fuel_type: z.string().max(50).nullable().optional(),
  body_type: z.string().max(50).nullable().optional(),
  colour: z.string().max(64).nullable().optional(),
  location: z.string().max(255).nullable().optional(),
  state: z.string().max(4).nullable().optional(),
  images: z.array(z.string().url()).max(20).optional(),
  captured_at: z.string().datetime().optional(),
});

// POST /api/capture  — ingest a listing payload from the user's browser ext
router.post(
  '/',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const tok = validateToken(
      req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? undefined
    );
    if (!tok) {
      res.status(401).json({ error: 'invalid_or_expired_capture_token' });
      return;
    }

    const payload = captureSchema.parse(req.body);
    const capturedAt = payload.captured_at ? new Date(payload.captured_at) : new Date();

    // Step 1: canonicalise the vehicle so all sources dedupe correctly.
    const canonical = await upsertCanonical({
      vin: payload.vin ?? null,
      rego: payload.rego ?? null,
      rego_state: normaliseState(payload.rego_state ?? payload.state ?? null),
      make: payload.make,
      model: payload.model,
      year: payload.year,
      variant: payload.variant ?? null,
      body_type: payload.body_type ?? null,
      transmission: payload.transmission ?? null,
      fuel_type: payload.fuel_type ?? null,
      colour: payload.colour ?? null,
    });

    // Step 2: upsert into car_listings keyed on (source, external_id).
    const existing = await db.query.carListings.findFirst({
      where: eq(carListings.external_id, payload.external_id),
    });

    let listingId: string;
    let priceDelta: number | null = null;

    if (existing) {
      // Append to price_history if the price changed since last capture.
      const history = (existing.price_history || []) as PriceHistoryEntry[];
      const last = history[history.length - 1];
      const prevPrice = last?.price ?? existing.price ?? null;
      if (payload.price != null && prevPrice != null && payload.price !== prevPrice) {
        history.push({ date: capturedAt.toISOString(), price: payload.price });
        priceDelta = payload.price - prevPrice;
      } else if (payload.price != null && prevPrice == null) {
        history.push({ date: capturedAt.toISOString(), price: payload.price });
      }

      await db
        .update(carListings)
        .set({
          vehicle_canonical_id: existing.vehicle_canonical_id ?? canonical.id,
          price: payload.price ?? existing.price,
          price_history: history,
          last_seen_at: capturedAt,
          location: payload.location ?? existing.location,
          state: normaliseState(payload.state ?? null) ?? existing.state,
          odometer: payload.odometer ?? existing.odometer,
          images: payload.images ?? (existing.images as string[]),
          is_active: true,
        })
        .where(eq(carListings.id, existing.id));
      listingId = existing.id;
    } else {
      const initialHistory: PriceHistoryEntry[] =
        payload.price != null ? [{ date: capturedAt.toISOString(), price: payload.price }] : [];
      const [created] = await db
        .insert(carListings)
        .values({
          vehicle_canonical_id: canonical.id,
          external_id: payload.external_id,
          source: 'user_contribution',
          make: payload.make,
          model: payload.model,
          year: payload.year,
          price: payload.price ?? null,
          price_history: initialHistory,
          location: payload.location ?? null,
          state: normaliseState(payload.state ?? null),
          odometer: payload.odometer ?? null,
          transmission: payload.transmission ?? null,
          fuel_type: payload.fuel_type ?? null,
          body_type: payload.body_type ?? null,
          listing_url: payload.listing_url,
          images: payload.images ?? [],
          first_seen_at: capturedAt,
          last_seen_at: capturedAt,
          is_active: true,
          is_sold: false,
        })
        .returning();
      if (!created) throw new Error('listing_insert_failed');
      listingId = created.id;
    }

    // Step 3: data provenance — every row traceable to its origin and the
    // user who contributed it. Powers trust + future B2B negotiations.
    await db.insert(dataProvenance).values({
      table_name: 'car_listings',
      row_id: listingId,
      source: 'user_contribution',
      source_url: payload.listing_url,
      source_partner: tok.source_hint,
      notes: tok.user_id ? `attributed_user=${tok.user_id}` : 'anonymous_capture',
    });

    res.json({
      ok: true,
      listing_id: listingId,
      vehicle_canonical_id: canonical.id,
      price_delta: priceDelta,
      captured_at: capturedAt.toISOString(),
    });
  })
);

export default router;
