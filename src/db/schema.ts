import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  text,
  pgEnum,
  decimal,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ─────────────────────────────────────────────────────────────────────────────
//  Enums
//
//  v2 — repositioned to "ownership intelligence layer".
//  ⚠️ The previous `listing_source` enum included `carsales/gumtree/facebook`.
//  Those are removed deliberately — see AUDIT_AND_UPLIFT.md §2.3 (legal risk).
//  All sources are now legitimate: dealer feeds, government registers, public
//  auctions, user contributions, and partner data feeds.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: enums are additive (we keep legacy values so existing code/queries
// keep working). Use the v2 values for all new code paths. See
// AUDIT_AND_UPLIFT.md §3 for which values to favour going forward.
export const subscriptionTierEnum = pgEnum('subscription_tier', [
  // legacy (kept for back-compat with existing code, do not use in new code)
  'free',
  'pro',
  'dealer',
  'enterprise',
  // v2 — four-surface model
  'watchlist',     // $9/mo consumer
  'dealer_edge',   // $499/mo dealer
  'inventory_iq',  // $1,499/mo dealer
  'group',         // $2,999/mo multi-location
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'trialing',
  'cancelled',
  'past_due',
  'paused',
]);

// ⚠️ Sources `carsales`, `gumtree`, `facebook` remain in the enum for legacy
// compatibility but are deprecated — DO NOT scrape these in new ingestion
// code. See AUDIT_AND_UPLIFT.md §2.3 for the legal reasoning. New ingestion
// must use one of the v2 sources below (dealer/auction/user/partner/ppsr).
export const listingSourceEnum = pgEnum('listing_source', [
  // legacy (deprecated — do not add new rows with these sources)
  'carsales',
  'gumtree',
  'facebook',
  'drive',
  // v2 — legitimate sources only
  'dealer_feed',
  'auction_pickles',
  'auction_manheim',
  'auction_grays',
  'auction_government',
  'user_contribution',
  'partner_feed',
  'ppsr_reference',
]);

export const reportStatusEnum = pgEnum('report_status', [
  'pending',
  'fetching',
  'ready',
  'failed',
  'refunded',
]);

export const dealStatusEnum = pgEnum('deal_status', [
  'intake',
  'searching',
  'shortlisted',
  'negotiating',
  'inspecting',
  'escrow',
  'completed',
  'cancelled',
  'refunded',
]);

export const dealerTierEnum = pgEnum('dealer_tier', [
  'edge',
  'inventory_iq',
  'group',
]);

// ─────────────────────────────────────────────────────────────────────────────
//  Users
// ─────────────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  password_hash: varchar('password_hash', { length: 255 }).notNull(),
  first_name: varchar('first_name', { length: 100 }).notNull(),
  last_name: varchar('last_name', { length: 100 }).notNull(),
  phone: varchar('phone', { length: 32 }),
  subscription_tier: subscriptionTierEnum('subscription_tier').notNull().default('free'),
  stripe_customer_id: varchar('stripe_customer_id', { length: 255 }),
  stripe_subscription_id: varchar('stripe_subscription_id', { length: 255 }),
  subscription_status: subscriptionStatusEnum('subscription_status'),
  subscription_expires_at: timestamp('subscription_expires_at', { withTimezone: true }),
  is_dealer: boolean('is_dealer').notNull().default(false),
  dealer_id: uuid('dealer_id'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  last_login_at: timestamp('last_login_at', { withTimezone: true }),
});

// ─────────────────────────────────────────────────────────────────────────────
//  Vehicle canonicalization
//
//  Single source of truth for "this vehicle". All listings, sold records,
//  PPSR checks, and reports hang off `vehicle_canonical_id`. Without this,
//  we can't dedupe Pickles vs dealer vs consumer source — see audit §4.3.
// ─────────────────────────────────────────────────────────────────────────────

export const vehicleCanonical = pgTable(
  'vehicle_canonical',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vin: varchar('vin', { length: 17 }),
    rego: varchar('rego', { length: 16 }),
    rego_state: varchar('rego_state', { length: 4 }),
    make: varchar('make', { length: 100 }).notNull(),
    model: varchar('model', { length: 100 }).notNull(),
    variant: varchar('variant', { length: 200 }),
    year: integer('year').notNull(),
    body_type: varchar('body_type', { length: 50 }),
    transmission: varchar('transmission', { length: 50 }),
    fuel_type: varchar('fuel_type', { length: 50 }),
    engine_litres: decimal('engine_litres', { precision: 4, scale: 2 }),
    drivetrain: varchar('drivetrain', { length: 16 }),
    colour: varchar('colour', { length: 64 }),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    last_updated_at: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata').notNull().default('{}'),
  },
  (t) => ({
    vinIdx: uniqueIndex('vehicle_canonical_vin_uq').on(t.vin),
    regoIdx: index('vehicle_canonical_rego_idx').on(t.rego, t.rego_state),
    mmyIdx: index('vehicle_canonical_mmy_idx').on(t.make, t.model, t.year),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  Listings (now keyed off the canonical vehicle)
// ─────────────────────────────────────────────────────────────────────────────

export const carListings = pgTable(
  'car_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vehicle_canonical_id: uuid('vehicle_canonical_id').references(() => vehicleCanonical.id, {
      onDelete: 'set null',
    }),
    external_id: varchar('external_id', { length: 255 }).notNull(),
    source: listingSourceEnum('source').notNull(),
    source_dealer_id: uuid('source_dealer_id'),
    make: varchar('make', { length: 100 }).notNull(),
    model: varchar('model', { length: 100 }).notNull(),
    year: integer('year').notNull(),
    price: integer('price'),
    price_history: jsonb('price_history').notNull().default('[]'),
    sold_price: integer('sold_price'),
    sold_date: timestamp('sold_date', { withTimezone: true }),
    location: varchar('location', { length: 255 }),
    state: varchar('state', { length: 4 }),
    odometer: integer('odometer'),
    transmission: varchar('transmission', { length: 50 }),
    fuel_type: varchar('fuel_type', { length: 50 }),
    body_type: varchar('body_type', { length: 50 }),
    listing_url: text('listing_url').notNull(),
    images: jsonb('images').notNull().default('[]'),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    removed_at: timestamp('removed_at', { withTimezone: true }),
    is_sold: boolean('is_sold').notNull().default(false),
    is_active: boolean('is_active').notNull().default(true),
  },
  (t) => ({
    sourceExternalIdx: uniqueIndex('car_listings_source_external_uq').on(t.source, t.external_id),
    canonicalIdx: index('car_listings_canonical_idx').on(t.vehicle_canonical_id),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  Vehicle Intelligence Report — the killer SKU ($19 one‑off)
// ─────────────────────────────────────────────────────────────────────────────

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    vehicle_canonical_id: uuid('vehicle_canonical_id').references(() => vehicleCanonical.id, {
      onDelete: 'set null',
    }),
    requested_vin: varchar('requested_vin', { length: 17 }),
    requested_rego: varchar('requested_rego', { length: 16 }),
    requested_state: varchar('requested_state', { length: 4 }),
    status: reportStatusEnum('status').notNull().default('pending'),
    stripe_payment_intent: varchar('stripe_payment_intent', { length: 255 }),
    stripe_checkout_session: varchar('stripe_checkout_session', { length: 255 }),
    customer_email: varchar('customer_email', { length: 255 }),
    email_sent_at: timestamp('email_sent_at', { withTimezone: true }),
    price_cents: integer('price_cents').notNull().default(1900),
    ppsr_payload: jsonb('ppsr_payload').notNull().default('{}'),
    nevdis_payload: jsonb('nevdis_payload').notNull().default('{}'),
    market_value_payload: jsonb('market_value_payload').notNull().default('{}'),
    summary: jsonb('summary').notNull().default('{}'),
    pdf_url: text('pdf_url'),
    error_message: text('error_message'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('reports_user_idx').on(t.user_id),
    statusIdx: index('reports_status_idx').on(t.status),
    checkoutSessionIdx: index('reports_checkout_session_idx').on(t.stripe_checkout_session),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  Dealers
// ─────────────────────────────────────────────────────────────────────────────

export const dealers = pgTable(
  'dealers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    business_name: varchar('business_name', { length: 255 }).notNull(),
    abn: varchar('abn', { length: 20 }),
    contact_email: varchar('contact_email', { length: 255 }).notNull(),
    contact_phone: varchar('contact_phone', { length: 32 }),
    state: varchar('state', { length: 4 }),
    suburb: varchar('suburb', { length: 100 }),
    tier: dealerTierEnum('tier').notNull().default('edge'),
    dms_provider: varchar('dms_provider', { length: 64 }),
    feed_active: boolean('feed_active').notNull().default(false),
    api_key: varchar('api_key', { length: 64 }),
    branding: jsonb('branding').notNull().default('{}'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    abnIdx: uniqueIndex('dealers_abn_uq').on(t.abn),
    apiKeyIdx: uniqueIndex('dealers_api_key_uq').on(t.api_key),
  })
);

export const dealerInventory = pgTable(
  'dealer_inventory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dealer_id: uuid('dealer_id').notNull().references(() => dealers.id, { onDelete: 'cascade' }),
    vehicle_canonical_id: uuid('vehicle_canonical_id').references(() => vehicleCanonical.id, {
      onDelete: 'set null',
    }),
    stock_number: varchar('stock_number', { length: 64 }),
    listed_price: integer('listed_price'),
    cost_basis: integer('cost_basis'),
    floorplan_cost_per_day_cents: integer('floorplan_cost_per_day_cents'),
    days_in_stock: integer('days_in_stock'),
    market_position_pct: decimal('market_position_pct', { precision: 6, scale: 2 }),
    forecast_days_to_sell: integer('forecast_days_to_sell'),
    is_sold: boolean('is_sold').notNull().default(false),
    sold_price: integer('sold_price'),
    sold_at: timestamp('sold_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dealerStockIdx: uniqueIndex('dealer_inventory_dealer_stock_uq').on(t.dealer_id, t.stock_number),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  Concierge — DriveMate ($499 + 1% of saving)
// ─────────────────────────────────────────────────────────────────────────────

export const conciergeDeals = pgTable(
  'concierge_deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    brief: jsonb('brief').notNull().default('{}'),
    target_make: varchar('target_make', { length: 100 }),
    target_model: varchar('target_model', { length: 100 }),
    target_year_min: integer('target_year_min'),
    target_year_max: integer('target_year_max'),
    target_km_max: integer('target_km_max'),
    target_price_max: integer('target_price_max'),
    target_state: varchar('target_state', { length: 4 }),
    deadline_at: timestamp('deadline_at', { withTimezone: true }),
    status: dealStatusEnum('status').notNull().default('intake'),
    purchased_vehicle_id: uuid('purchased_vehicle_id').references(() => vehicleCanonical.id, {
      onDelete: 'set null',
    }),
    asking_price: integer('asking_price'),
    final_price: integer('final_price'),
    saving: integer('saving'),
    base_fee_cents: integer('base_fee_cents').notNull().default(49900),
    success_fee_cents: integer('success_fee_cents').notNull().default(0),
    stripe_session_id: varchar('stripe_session_id', { length: 255 }),
    notes: text('notes'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('concierge_deals_user_idx').on(t.user_id),
    statusIdx: index('concierge_deals_status_idx').on(t.status),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  Data provenance — every row should be traceable to its source for trust
//  and for negotiating future B2B feed deals.
// ─────────────────────────────────────────────────────────────────────────────

export const dataProvenance = pgTable(
  'data_provenance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    table_name: varchar('table_name', { length: 64 }).notNull(),
    row_id: uuid('row_id').notNull(),
    source: listingSourceEnum('source').notNull(),
    source_url: text('source_url'),
    source_partner: varchar('source_partner', { length: 128 }),
    fetched_at: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    licence: varchar('licence', { length: 64 }),
    notes: text('notes'),
  },
  (t) => ({
    refIdx: index('data_provenance_ref_idx').on(t.table_name, t.row_id),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
//  Existing user features (kept, lightly updated)
// ─────────────────────────────────────────────────────────────────────────────

export const priceAlerts = pgTable('price_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  make: varchar('make', { length: 100 }),
  model: varchar('model', { length: 100 }),
  year_min: integer('year_min'),
  year_max: integer('year_max'),
  price_max: integer('price_max'),
  location: varchar('location', { length: 255 }),
  state: varchar('state', { length: 4 }),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const savedSearches = pgTable('saved_searches', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  search_params: jsonb('search_params').notNull().default('{}'),
  name: varchar('name', { length: 255 }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiUsage = pgTable('api_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  endpoint: varchar('endpoint', { length: 255 }).notNull(),
  cost_cents: integer('cost_cents').notNull().default(0),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
  ip_address: varchar('ip_address', { length: 45 }).notNull(),
});

// ─────────────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type VehicleCanonical = typeof vehicleCanonical.$inferSelect;
export type NewVehicleCanonical = typeof vehicleCanonical.$inferInsert;

export type CarListing = typeof carListings.$inferSelect;
export type NewCarListing = typeof carListings.$inferInsert;

export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;

export type Dealer = typeof dealers.$inferSelect;
export type NewDealer = typeof dealers.$inferInsert;

export type DealerInventory = typeof dealerInventory.$inferSelect;
export type NewDealerInventory = typeof dealerInventory.$inferInsert;

export type ConciergeDeal = typeof conciergeDeals.$inferSelect;
export type NewConciergeDeal = typeof conciergeDeals.$inferInsert;

export type DataProvenance = typeof dataProvenance.$inferSelect;
export type NewDataProvenance = typeof dataProvenance.$inferInsert;

export type PriceAlert = typeof priceAlerts.$inferSelect;
export type NewPriceAlert = typeof priceAlerts.$inferInsert;

export type SavedSearch = typeof savedSearches.$inferSelect;
export type NewSavedSearch = typeof savedSearches.$inferInsert;

export type ApiUsage = typeof apiUsage.$inferSelect;
export type NewApiUsage = typeof apiUsage.$inferInsert;
