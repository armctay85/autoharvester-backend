import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
//  Environment schema
//
//  Stripe credentials are intentionally OPTIONAL. The backend must boot
//  cleanly on Railway/Render *before* you have created products in Stripe so
//  that you can deploy first, then run `npm run stripe:setup`, then paste
//  the resulting price IDs back into env vars and redeploy. See DEPLOY.md.
// ─────────────────────────────────────────────────────────────────────────────

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Stripe — all OPTIONAL so first-boot works without billing configured
  STRIPE_SECRET_KEY: z.string().optional().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),

  // Canonical 5-SKU pricing (see autoharvester/src/app/pricing/page.tsx).
  // One-off Vehicle Intelligence Report
  STRIPE_PRICE_REPORT: z.string().optional().default(''),
  // Consumer Watchlist Lite — $9/mo
  STRIPE_PRICE_WATCHLIST_MONTHLY: z.string().optional().default(''),
  STRIPE_PRICE_WATCHLIST_YEARLY: z.string().optional().default(''),
  // Dealer Edge — $499/mo
  STRIPE_PRICE_EDGE_MONTHLY: z.string().optional().default(''),
  STRIPE_PRICE_EDGE_YEARLY: z.string().optional().default(''),
  // Inventory IQ — $1,499/mo
  STRIPE_PRICE_INVENTORY_IQ_MONTHLY: z.string().optional().default(''),
  STRIPE_PRICE_INVENTORY_IQ_YEARLY: z.string().optional().default(''),
  // Group — $2,999/mo
  STRIPE_PRICE_GROUP_MONTHLY: z.string().optional().default(''),
  STRIPE_PRICE_GROUP_YEARLY: z.string().optional().default(''),

  // Legacy slots (kept so older code paths don't crash; deprecated, do not set in new envs)
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional().default(''),
  STRIPE_PRICE_PRO_YEARLY: z.string().optional().default(''),
  STRIPE_PRICE_DEALER_MONTHLY: z.string().optional().default(''),
  STRIPE_PRICE_DEALER_YEARLY: z.string().optional().default(''),

  // Security — required in production, generated/loose in dev
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .default('dev-jwt-secret-change-me-please-its-only-for-local-dev-okay'),
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 characters')
    .default('dev-session-secret-change-me-please-its-only-for-local-dev'),

  // App
  FRONTEND_URL: z.string().url().default('https://autoharvester.com.au'),
  PORT: z.string().transform(Number).default('3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  parsed.error.issues.forEach((issue) => {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

export const env = parsed.data;

// ─────────────────────────────────────────────────────────────────────────────
//  Stripe SKU map — canonical AutoHarvester pricing (see pricing page)
// ─────────────────────────────────────────────────────────────────────────────

export const STRIPE_PRICES = {
  // One-off
  report: env.STRIPE_PRICE_REPORT,

  // Consumer recurring
  watchlist: {
    monthly: env.STRIPE_PRICE_WATCHLIST_MONTHLY,
    yearly: env.STRIPE_PRICE_WATCHLIST_YEARLY,
  },

  // Dealer recurring
  dealer_edge: {
    monthly: env.STRIPE_PRICE_EDGE_MONTHLY,
    yearly: env.STRIPE_PRICE_EDGE_YEARLY,
  },
  inventory_iq: {
    monthly: env.STRIPE_PRICE_INVENTORY_IQ_MONTHLY,
    yearly: env.STRIPE_PRICE_INVENTORY_IQ_YEARLY,
  },
  group: {
    monthly: env.STRIPE_PRICE_GROUP_MONTHLY,
    yearly: env.STRIPE_PRICE_GROUP_YEARLY,
  },

  // Legacy mappings — kept so existing webhook code that compares against
  // `STRIPE_PRICES.pro.*` / `STRIPE_PRICES.dealer.*` does not blow up. They
  // alias onto the new SKUs so live traffic still routes correctly.
  pro: {
    monthly: env.STRIPE_PRICE_PRO_MONTHLY || env.STRIPE_PRICE_WATCHLIST_MONTHLY,
    yearly: env.STRIPE_PRICE_PRO_YEARLY || env.STRIPE_PRICE_WATCHLIST_YEARLY,
  },
  dealer: {
    monthly: env.STRIPE_PRICE_DEALER_MONTHLY || env.STRIPE_PRICE_EDGE_MONTHLY,
    yearly: env.STRIPE_PRICE_DEALER_YEARLY || env.STRIPE_PRICE_EDGE_YEARLY,
  },
} as const;

export function isStripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function isBillingFullyWired(): boolean {
  return Boolean(
    env.STRIPE_SECRET_KEY &&
      env.STRIPE_WEBHOOK_SECRET &&
      env.STRIPE_PRICE_REPORT &&
      env.STRIPE_PRICE_WATCHLIST_MONTHLY &&
      env.STRIPE_PRICE_EDGE_MONTHLY &&
      env.STRIPE_PRICE_INVENTORY_IQ_MONTHLY &&
      env.STRIPE_PRICE_GROUP_MONTHLY,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tier configuration — what each subscription tier unlocks
// ─────────────────────────────────────────────────────────────────────────────

interface TierConfig {
  name: string;
  maxSearches: number;
  maxAlerts: number;
  canViewSoldPrices: boolean;
  canExportData: boolean;
  canBulkImport?: boolean;
  hasAdminAccess?: boolean;
  hasApiAccess?: boolean;
  monthlyReportsIncluded?: number;
  maxTrackedVehicles?: number;
}

const tierConfigs: Record<string, TierConfig> = {
  // Default
  free: {
    name: 'Free',
    maxSearches: 5,
    maxAlerts: 1,
    canViewSoldPrices: false,
    canExportData: false,
  },

  // ─── Consumer ────────────────────────────────────────────────────────────
  watchlist: {
    name: 'Watchlist Lite',
    maxSearches: 100,
    maxAlerts: 999, // unlimited per pricing page
    canViewSoldPrices: true,
    canExportData: true,
    monthlyReportsIncluded: 1,
  },

  // ─── Dealer ──────────────────────────────────────────────────────────────
  dealer_edge: {
    name: 'Dealer Edge',
    maxSearches: 1_000,
    maxAlerts: 200,
    canViewSoldPrices: true,
    canExportData: true,
    canBulkImport: true,
    hasAdminAccess: true,
    maxTrackedVehicles: 100,
  },
  inventory_iq: {
    name: 'Inventory IQ',
    maxSearches: 5_000,
    maxAlerts: 1_000,
    canViewSoldPrices: true,
    canExportData: true,
    canBulkImport: true,
    hasAdminAccess: true,
    maxTrackedVehicles: 500,
  },
  group: {
    name: 'Group',
    maxSearches: 50_000,
    maxAlerts: 10_000,
    canViewSoldPrices: true,
    canExportData: true,
    canBulkImport: true,
    hasAdminAccess: true,
    hasApiAccess: true,
    maxTrackedVehicles: 9_999,
  },

  // ─── Legacy (mapped to nearest v2 tier behaviour) ────────────────────────
  pro: {
    name: 'Pro (legacy)',
    maxSearches: 50,
    maxAlerts: 10,
    canViewSoldPrices: true,
    canExportData: true,
    monthlyReportsIncluded: 1,
  },
  dealer: {
    name: 'Dealer (legacy)',
    maxSearches: 500,
    maxAlerts: 100,
    canViewSoldPrices: true,
    canExportData: true,
    canBulkImport: true,
    hasAdminAccess: true,
    maxTrackedVehicles: 100,
  },
  enterprise: {
    name: 'Enterprise (legacy)',
    maxSearches: 999_999,
    maxAlerts: 999_999,
    canViewSoldPrices: true,
    canExportData: true,
    canBulkImport: true,
    hasAdminAccess: true,
    hasApiAccess: true,
    maxTrackedVehicles: 9_999,
  },
};

export function getTierConfig(tier: string): TierConfig {
  const config = tierConfigs[tier];
  if (config) return config;
  return tierConfigs['free'] as TierConfig;
}

export const SUBSCRIPTION_TIERS = tierConfigs;
