import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  
  // Stripe
  STRIPE_SECRET_KEY: z.string().min(1, 'STRIPE_SECRET_KEY is required'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'STRIPE_WEBHOOK_SECRET is required'),
  STRIPE_PRICE_PRO_MONTHLY: z.string().min(1, 'STRIPE_PRICE_PRO_MONTHLY is required'),
  STRIPE_PRICE_PRO_YEARLY: z.string().min(1, 'STRIPE_PRICE_PRO_YEARLY is required'),
  STRIPE_PRICE_DEALER_MONTHLY: z.string().min(1, 'STRIPE_PRICE_DEALER_MONTHLY is required'),
  STRIPE_PRICE_DEALER_YEARLY: z.string().min(1, 'STRIPE_PRICE_DEALER_YEARLY is required'),
  
  // Security
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  
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

// Stripe price IDs mapping
export const STRIPE_PRICES = {
  pro: {
    monthly: env.STRIPE_PRICE_PRO_MONTHLY,
    yearly: env.STRIPE_PRICE_PRO_YEARLY,
  },
  dealer: {
    monthly: env.STRIPE_PRICE_DEALER_MONTHLY,
    yearly: env.STRIPE_PRICE_DEALER_YEARLY,
  },
} as const;

// Subscription tiers configuration
interface TierConfig {
  name: string;
  maxSearches: number;
  maxAlerts: number;
  canViewSoldPrices: boolean;
  canExportData: boolean;
  canBulkImport?: boolean;
  hasAdminAccess?: boolean;
  hasApiAccess?: boolean;
}

const tierConfigs: Record<string, TierConfig> = {
  free: {
    name: 'Free',
    maxSearches: 5,
    maxAlerts: 1,
    canViewSoldPrices: false,
    canExportData: false,
  },
  pro: {
    name: 'Pro',
    maxSearches: 50,
    maxAlerts: 10,
    canViewSoldPrices: true,
    canExportData: true,
  },
  dealer: {
    name: 'Dealer',
    maxSearches: 500,
    maxAlerts: 100,
    canViewSoldPrices: true,
    canExportData: true,
    canBulkImport: true,
    hasAdminAccess: true,
  },
  enterprise: {
    name: 'Enterprise',
    maxSearches: 999999,
    maxAlerts: 999999,
    canViewSoldPrices: true,
    canExportData: true,
    canBulkImport: true,
    hasAdminAccess: true,
    hasApiAccess: true,
  },
};

// Safe tier getter function
export function getTierConfig(tier: string): TierConfig {
  const config = tierConfigs[tier];
  if (config) {
    return config;
  }
  // free tier is guaranteed to exist
  return tierConfigs['free'] as TierConfig;
}

// Keep original export for compatibility
export const SUBSCRIPTION_TIERS = tierConfigs;
