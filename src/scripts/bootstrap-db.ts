/**
 * One-shot DB bootstrap. Creates the AutoHarvester schema if missing.
 *
 * Why this exists:
 *   - drizzle-kit push:pg is interactive (TUI prompts) → unusable in CI / boot.
 *   - drizzle-kit migrate needs generated SQL files committed first.
 *   - For a greenfield Railway DB we just want the schema there *now*.
 *
 * This script is idempotent: every CREATE / ALTER is wrapped in
 * IF NOT EXISTS / DO $$ … duplicate_object guards, so it's safe to
 * re-run any number of times.
 *
 * Usage (local one-shot):
 *   $env:DATABASE_URL="postgresql://…"
 *   npx tsx src/scripts/bootstrap-db.ts
 */
import { Client } from 'pg';

const SQL = `
DO $$ BEGIN
 CREATE TYPE "deal_status" AS ENUM('intake','searching','shortlisted','negotiating','inspecting','escrow','completed','cancelled','refunded');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 CREATE TYPE "dealer_tier" AS ENUM('edge','inventory_iq','group');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 CREATE TYPE "listing_source" AS ENUM('carsales','gumtree','facebook','drive','dealer_feed','auction_pickles','auction_manheim','auction_grays','auction_government','user_contribution','partner_feed','ppsr_reference');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 CREATE TYPE "report_status" AS ENUM('pending','fetching','ready','failed','refunded');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 CREATE TYPE "subscription_status" AS ENUM('active','trialing','cancelled','past_due','paused');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 CREATE TYPE "subscription_tier" AS ENUM('free','pro','dealer','enterprise','watchlist','dealer_edge','inventory_iq','group');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" varchar(255) NOT NULL,
  "password_hash" varchar(255),
  "first_name" varchar(100),
  "last_name" varchar(100),
  "phone" varchar(32),
  "subscription_tier" "subscription_tier" DEFAULT 'free' NOT NULL,
  "stripe_customer_id" varchar(255),
  "stripe_subscription_id" varchar(255),
  "subscription_status" "subscription_status",
  "subscription_expires_at" timestamp with time zone,
  "is_dealer" boolean DEFAULT false NOT NULL,
  "dealer_id" uuid,
  "email_verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_login_at" timestamp with time zone,
  CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE IF NOT EXISTS "vehicle_canonical" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vin" varchar(17),
  "rego" varchar(16),
  "rego_state" varchar(4),
  "make" varchar(100) NOT NULL,
  "model" varchar(100) NOT NULL,
  "variant" varchar(200),
  "year" integer NOT NULL,
  "body_type" varchar(50),
  "transmission" varchar(50),
  "fuel_type" varchar(50),
  "engine_litres" numeric(4, 2),
  "drivetrain" varchar(16),
  "colour" varchar(64),
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata" jsonb DEFAULT '{}' NOT NULL
);

CREATE TABLE IF NOT EXISTS "dealers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_name" varchar(255) NOT NULL,
  "abn" varchar(20),
  "contact_email" varchar(255) NOT NULL,
  "contact_phone" varchar(32),
  "state" varchar(4),
  "suburb" varchar(100),
  "tier" "dealer_tier" DEFAULT 'edge' NOT NULL,
  "dms_provider" varchar(64),
  "feed_active" boolean DEFAULT false NOT NULL,
  "api_key" varchar(64),
  "branding" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "car_listings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vehicle_canonical_id" uuid,
  "external_id" varchar(255) NOT NULL,
  "source" "listing_source" NOT NULL,
  "source_dealer_id" uuid,
  "make" varchar(100) NOT NULL,
  "model" varchar(100) NOT NULL,
  "year" integer NOT NULL,
  "price" integer,
  "price_history" jsonb DEFAULT '[]' NOT NULL,
  "sold_price" integer,
  "sold_date" timestamp with time zone,
  "location" varchar(255),
  "state" varchar(4),
  "odometer" integer,
  "transmission" varchar(50),
  "fuel_type" varchar(50),
  "body_type" varchar(50),
  "listing_url" text NOT NULL,
  "images" jsonb DEFAULT '[]' NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "removed_at" timestamp with time zone,
  "is_sold" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS "concierge_deals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "brief" jsonb DEFAULT '{}' NOT NULL,
  "target_make" varchar(100),
  "target_model" varchar(100),
  "target_year_min" integer,
  "target_year_max" integer,
  "target_km_max" integer,
  "target_price_max" integer,
  "target_state" varchar(4),
  "deadline_at" timestamp with time zone,
  "status" "deal_status" DEFAULT 'intake' NOT NULL,
  "purchased_vehicle_id" uuid,
  "asking_price" integer,
  "final_price" integer,
  "saving" integer,
  "base_fee_cents" integer DEFAULT 49900 NOT NULL,
  "success_fee_cents" integer DEFAULT 0 NOT NULL,
  "stripe_session_id" varchar(255),
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "data_provenance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "table_name" varchar(64) NOT NULL,
  "row_id" uuid NOT NULL,
  "source" "listing_source" NOT NULL,
  "source_url" text,
  "source_partner" varchar(128),
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "licence" varchar(64),
  "notes" text
);

CREATE TABLE IF NOT EXISTS "dealer_inventory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dealer_id" uuid NOT NULL,
  "vehicle_canonical_id" uuid,
  "stock_number" varchar(64),
  "listed_price" integer,
  "cost_basis" integer,
  "floorplan_cost_per_day_cents" integer,
  "days_in_stock" integer,
  "market_position_pct" numeric(6, 2),
  "forecast_days_to_sell" integer,
  "is_sold" boolean DEFAULT false NOT NULL,
  "sold_price" integer,
  "sold_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "price_alerts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "make" varchar(100),
  "model" varchar(100),
  "year_min" integer,
  "year_max" integer,
  "price_max" integer,
  "location" varchar(255),
  "state" varchar(4),
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "vehicle_canonical_id" uuid,
  "requested_vin" varchar(17),
  "requested_rego" varchar(16),
  "requested_state" varchar(4),
  "status" "report_status" DEFAULT 'pending' NOT NULL,
  "stripe_payment_intent" varchar(255),
  "stripe_checkout_session" varchar(255),
  "customer_email" varchar(255),
  "email_sent_at" timestamp with time zone,
  "price_cents" integer DEFAULT 1900 NOT NULL,
  "ppsr_payload" jsonb DEFAULT '{}' NOT NULL,
  "nevdis_payload" jsonb DEFAULT '{}' NOT NULL,
  "market_value_payload" jsonb DEFAULT '{}' NOT NULL,
  "summary" jsonb DEFAULT '{}' NOT NULL,
  "pdf_url" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "saved_searches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "search_params" jsonb DEFAULT '{}' NOT NULL,
  "name" varchar(255) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "api_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "endpoint" varchar(255) NOT NULL,
  "cost_cents" integer DEFAULT 0 NOT NULL,
  "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
  "ip_address" varchar(45) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "car_listings_source_external_uq" ON "car_listings" ("source","external_id");
CREATE INDEX IF NOT EXISTS "car_listings_canonical_idx" ON "car_listings" ("vehicle_canonical_id");
CREATE INDEX IF NOT EXISTS "concierge_deals_user_idx" ON "concierge_deals" ("user_id");
CREATE INDEX IF NOT EXISTS "concierge_deals_status_idx" ON "concierge_deals" ("status");
CREATE INDEX IF NOT EXISTS "data_provenance_ref_idx" ON "data_provenance" ("table_name","row_id");
CREATE UNIQUE INDEX IF NOT EXISTS "dealer_inventory_dealer_stock_uq" ON "dealer_inventory" ("dealer_id","stock_number");
CREATE UNIQUE INDEX IF NOT EXISTS "dealers_abn_uq" ON "dealers" ("abn");
CREATE UNIQUE INDEX IF NOT EXISTS "dealers_api_key_uq" ON "dealers" ("api_key");
CREATE INDEX IF NOT EXISTS "reports_user_idx" ON "reports" ("user_id");
CREATE INDEX IF NOT EXISTS "reports_status_idx" ON "reports" ("status");
CREATE INDEX IF NOT EXISTS "reports_checkout_session_idx" ON "reports" ("stripe_checkout_session");
CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_canonical_vin_uq" ON "vehicle_canonical" ("vin");
CREATE INDEX IF NOT EXISTS "vehicle_canonical_rego_idx" ON "vehicle_canonical" ("rego","rego_state");
CREATE INDEX IF NOT EXISTS "vehicle_canonical_mmy_idx" ON "vehicle_canonical" ("make","model","year");

DO $$ BEGIN
 ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "car_listings" ADD CONSTRAINT "car_listings_vehicle_canonical_id_vehicle_canonical_id_fk" FOREIGN KEY ("vehicle_canonical_id") REFERENCES "vehicle_canonical"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "concierge_deals" ADD CONSTRAINT "concierge_deals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "concierge_deals" ADD CONSTRAINT "concierge_deals_purchased_vehicle_id_vehicle_canonical_id_fk" FOREIGN KEY ("purchased_vehicle_id") REFERENCES "vehicle_canonical"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "dealer_inventory" ADD CONSTRAINT "dealer_inventory_dealer_id_dealers_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "dealers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "dealer_inventory" ADD CONSTRAINT "dealer_inventory_vehicle_canonical_id_vehicle_canonical_id_fk" FOREIGN KEY ("vehicle_canonical_id") REFERENCES "vehicle_canonical"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "reports" ADD CONSTRAINT "reports_vehicle_canonical_id_vehicle_canonical_id_fk" FOREIGN KEY ("vehicle_canonical_id") REFERENCES "vehicle_canonical"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
 ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('[bootstrap-db] connected');
  try {
    await client.query(SQL);
    console.log('[bootstrap-db] schema applied (idempotent)');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[bootstrap-db] failed:', err);
  process.exit(1);
});
