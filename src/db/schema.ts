import { 
  pgTable, 
  uuid, 
  varchar, 
  timestamp, 
  boolean, 
  integer, 
  jsonb, 
  text,
  pgEnum
} from 'drizzle-orm/pg-core';

// Enums
export const subscriptionTierEnum = pgEnum('subscription_tier', ['free', 'pro', 'dealer', 'enterprise']);
export const subscriptionStatusEnum = pgEnum('subscription_status', ['active', 'cancelled', 'past_due']);
export const listingSourceEnum = pgEnum('listing_source', ['carsales', 'gumtree', 'facebook', 'drive']);

// Users table
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  password_hash: varchar('password_hash', { length: 255 }).notNull(),
  first_name: varchar('first_name', { length: 100 }).notNull(),
  last_name: varchar('last_name', { length: 100 }).notNull(),
  subscription_tier: subscriptionTierEnum('subscription_tier').notNull().default('free'),
  stripe_customer_id: varchar('stripe_customer_id', { length: 255 }),
  stripe_subscription_id: varchar('stripe_subscription_id', { length: 255 }),
  subscription_status: subscriptionStatusEnum('subscription_status'),
  subscription_expires_at: timestamp('subscription_expires_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  last_login_at: timestamp('last_login_at', { withTimezone: true }),
});

// Car listings table
export const carListings = pgTable('car_listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  external_id: varchar('external_id', { length: 255 }).notNull(),
  source: listingSourceEnum('source').notNull(),
  make: varchar('make', { length: 100 }).notNull(),
  model: varchar('model', { length: 100 }).notNull(),
  year: integer('year').notNull(),
  price: integer('price'),
  price_history: jsonb('price_history').notNull().default('[]'),
  sold_price: integer('sold_price'),
  sold_date: timestamp('sold_date', { withTimezone: true }),
  location: varchar('location', { length: 255 }),
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
});

// Price alerts table
export const priceAlerts = pgTable('price_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  make: varchar('make', { length: 100 }),
  model: varchar('model', { length: 100 }),
  year_min: integer('year_min'),
  year_max: integer('year_max'),
  price_max: integer('price_max'),
  location: varchar('location', { length: 255 }),
  is_active: boolean('is_active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Saved searches table
export const savedSearches = pgTable('saved_searches', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  search_params: jsonb('search_params').notNull().default('{}'),
  name: varchar('name', { length: 255 }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// API usage table
export const apiUsage = pgTable('api_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  endpoint: varchar('endpoint', { length: 255 }).notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
  ip_address: varchar('ip_address', { length: 45 }).notNull(),
});

// Types
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type CarListing = typeof carListings.$inferSelect;
export type NewCarListing = typeof carListings.$inferInsert;
export type PriceAlert = typeof priceAlerts.$inferSelect;
export type NewPriceAlert = typeof priceAlerts.$inferInsert;
export type SavedSearch = typeof savedSearches.$inferSelect;
export type NewSavedSearch = typeof savedSearches.$inferInsert;
export type ApiUsage = typeof apiUsage.$inferSelect;
export type NewApiUsage = typeof apiUsage.$inferInsert;
