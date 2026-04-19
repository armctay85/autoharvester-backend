import { db } from '../config/database';
import { vehicleCanonical, type NewVehicleCanonical, type VehicleCanonical } from '../db/schema';
import { and, eq, sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
//  Vehicle canonicalization
//
//  Every listing/sale/PPSR/report must point at exactly one row in
//  `vehicle_canonical`. Without this, dedupe across sources is impossible
//  (Pickles vs dealer vs user contribution will all double-count).
//
//  Lookup priority:
//    1. VIN (primary key — globally unique)
//    2. Rego + State (state-unique while registered)
//    3. (make, model, year, variant, km bucket) — fuzzy fallback
//
//  See AUDIT_AND_UPLIFT.md §4.3
// ─────────────────────────────────────────────────────────────────────────────

const AU_STATES = new Set(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']);

export function normaliseVin(input?: string | null): string | null {
  if (!input) return null;
  const cleaned = input.trim().toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
  return cleaned.length === 17 ? cleaned : null;
}

export function normaliseRego(input?: string | null): string | null {
  if (!input) return null;
  return input.trim().toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '') || null;
}

export function normaliseState(input?: string | null): string | null {
  if (!input) return null;
  const v = input.trim().toUpperCase();
  return AU_STATES.has(v) ? v : null;
}

export interface CanonicalLookup {
  vin?: string | null;
  rego?: string | null;
  rego_state?: string | null;
  make?: string;
  model?: string;
  year?: number;
  variant?: string | null;
}

/**
 * Find an existing canonical vehicle by VIN, or rego+state, or
 * (make,model,year,variant) — in that priority order.
 */
export async function findCanonical(q: CanonicalLookup): Promise<VehicleCanonical | null> {
  const vin = normaliseVin(q.vin);
  if (vin) {
    const [row] = await db.select().from(vehicleCanonical).where(eq(vehicleCanonical.vin, vin));
    if (row) return row;
  }

  const rego = normaliseRego(q.rego);
  const state = normaliseState(q.rego_state);
  if (rego && state) {
    const [row] = await db
      .select()
      .from(vehicleCanonical)
      .where(and(eq(vehicleCanonical.rego, rego), eq(vehicleCanonical.rego_state, state)));
    if (row) return row;
  }

  if (q.make && q.model && q.year) {
    const [row] = await db
      .select()
      .from(vehicleCanonical)
      .where(
        and(
          sql`lower(${vehicleCanonical.make}) = lower(${q.make})`,
          sql`lower(${vehicleCanonical.model}) = lower(${q.model})`,
          eq(vehicleCanonical.year, q.year),
          q.variant
            ? sql`lower(coalesce(${vehicleCanonical.variant}, '')) = lower(${q.variant})`
            : sql`coalesce(${vehicleCanonical.variant}, '') = ''`
        )
      );
    if (row) return row;
  }

  return null;
}

/**
 * Find or insert a canonical vehicle. Idempotent on VIN.
 */
export async function upsertCanonical(input: CanonicalLookup & {
  body_type?: string | null;
  transmission?: string | null;
  fuel_type?: string | null;
  colour?: string | null;
}): Promise<VehicleCanonical> {
  const existing = await findCanonical(input);
  if (existing) {
    // Touch + opportunistically backfill missing fields
    const patch: Partial<NewVehicleCanonical> = { last_updated_at: new Date() };
    if (!existing.vin && normaliseVin(input.vin)) patch.vin = normaliseVin(input.vin)!;
    if (!existing.rego && normaliseRego(input.rego)) patch.rego = normaliseRego(input.rego)!;
    if (!existing.rego_state && normaliseState(input.rego_state)) patch.rego_state = normaliseState(input.rego_state)!;
    if (!existing.body_type && input.body_type) patch.body_type = input.body_type;
    if (!existing.transmission && input.transmission) patch.transmission = input.transmission;
    if (!existing.fuel_type && input.fuel_type) patch.fuel_type = input.fuel_type;
    if (!existing.colour && input.colour) patch.colour = input.colour;
    if (!existing.variant && input.variant) patch.variant = input.variant;

    if (Object.keys(patch).length > 1) {
      await db.update(vehicleCanonical).set(patch).where(eq(vehicleCanonical.id, existing.id));
    }
    return { ...existing, ...patch } as VehicleCanonical;
  }

  if (!input.make || !input.model || !input.year) {
    throw new Error('canonical_insert_requires_make_model_year');
  }

  const [row] = await db
    .insert(vehicleCanonical)
    .values({
      vin: normaliseVin(input.vin),
      rego: normaliseRego(input.rego),
      rego_state: normaliseState(input.rego_state),
      make: input.make,
      model: input.model,
      year: input.year,
      variant: input.variant ?? null,
      body_type: input.body_type ?? null,
      transmission: input.transmission ?? null,
      fuel_type: input.fuel_type ?? null,
      colour: input.colour ?? null,
    })
    .returning();

  return row;
}
