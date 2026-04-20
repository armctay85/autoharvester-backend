import Stripe from 'stripe';
import { env, isStripeConfigured } from './env';

// ─────────────────────────────────────────────────────────────────────────────
//  Lazy Stripe client
//
//  We instantiate `Stripe` on first access so the backend can boot before
//  STRIPE_SECRET_KEY is populated (Railway / first-deploy posture).
//  Any code path that *needs* Stripe should call `getStripe()` and surface
//  a clean 503 if it returns null.
// ─────────────────────────────────────────────────────────────────────────────

let _client: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (!isStripeConfigured()) return null;
  if (!_client) {
    _client = new Stripe(env.STRIPE_SECRET_KEY, {
      // Pinned to the version the local types were generated against.
      apiVersion: '2023-10-16',
    });
  }
  return _client;
}

/**
 * Back-compat shim: existing code does `import { stripe } from './stripe'`
 * and calls `stripe.x.y(...)`. We proxy through `getStripe()` so that
 * unconfigured environments throw a *clear* error at call time instead of a
 * cryptic null-deref during boot.
 */
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const client = getStripe();
    if (!client) {
      throw new Error(
        `Stripe is not configured (STRIPE_SECRET_KEY missing). ` +
          `Set Stripe env vars and run \`npm run stripe:setup\` once. See DEPLOY.md.`,
      );
    }
    return (client as any)[prop];
  },
});

export const STRIPE_WEBHOOK_EVENTS = {
  CHECKOUT_COMPLETED: 'checkout.session.completed',
  INVOICE_PAID: 'invoice.paid',
  INVOICE_PAYMENT_FAILED: 'invoice.payment_failed',
  SUBSCRIPTION_DELETED: 'customer.subscription.deleted',
  SUBSCRIPTION_UPDATED: 'customer.subscription.updated',
  PAYMENT_INTENT_SUCCEEDED: 'payment_intent.succeeded',
} as const;

export const constructWebhookEvent = (payload: Buffer, signature: string): Stripe.Event => {
  const client = getStripe();
  if (!client) {
    throw new Error('Stripe webhook received but STRIPE_SECRET_KEY is not configured.');
  }
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('Stripe webhook received but STRIPE_WEBHOOK_SECRET is not configured.');
  }
  return client.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
};

export const createCustomer = async (email: string, name: string): Promise<Stripe.Customer> => {
  const client = getStripe();
  if (!client) throw new Error('Stripe not configured');
  return client.customers.create({ email, name });
};

export const createCheckoutSession = async (
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string,
  opts: {
    mode?: 'subscription' | 'payment';
    trialDays?: number;
    metadata?: Record<string, string>;
    customerEmail?: string;
    allowPromotionCodes?: boolean;
  } = {},
): Promise<Stripe.Checkout.Session> => {
  const client = getStripe();
  if (!client) throw new Error('Stripe not configured');
  const mode = opts.mode ?? 'subscription';
  const params: Stripe.Checkout.SessionCreateParams = {
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    mode,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: opts.metadata,
    allow_promotion_codes: opts.allowPromotionCodes ?? true,
  };

  // Stripe requires EITHER a customer id OR (optionally) a customer_email
  // hint — never an empty `customer` string. Empty string triggers a
  // `resource_missing` 400.
  if (customerId) {
    params.customer = customerId;
  } else if (opts.customerEmail) {
    params.customer_email = opts.customerEmail;
  }

  // For guest one-off payments, always collect an email so we can deliver
  // the receipt / report PDF. Stripe surfaces this back in
  // session.customer_details.email.
  if (mode === 'payment' && !customerId) {
    params.customer_creation = 'always';
  }

  if (mode === 'subscription' && opts.trialDays) {
    params.subscription_data = { trial_period_days: opts.trialDays };
  }
  return client.checkout.sessions.create(params);
};

export const createBillingPortalSession = async (
  customerId: string,
  returnUrl: string,
): Promise<Stripe.BillingPortal.Session> => {
  const client = getStripe();
  if (!client) throw new Error('Stripe not configured');
  return client.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
};

export const cancelSubscription = async (subscriptionId: string): Promise<Stripe.Subscription> => {
  const client = getStripe();
  if (!client) throw new Error('Stripe not configured');
  return client.subscriptions.cancel(subscriptionId);
};

export const getSubscription = async (subscriptionId: string): Promise<Stripe.Subscription> => {
  const client = getStripe();
  if (!client) throw new Error('Stripe not configured');
  return client.subscriptions.retrieve(subscriptionId);
};

// ─────────────────────────────────────────────────────────────────────────────
//  Subscription plan catalogue — canonical 5-SKU pricing
//  Mirrors autoharvester/src/app/pricing/page.tsx (the published source of truth).
// ─────────────────────────────────────────────────────────────────────────────

export type SubscriptionPlanId =
  | 'watchlist-monthly'
  | 'watchlist-yearly'
  | 'edge-monthly'
  | 'edge-yearly'
  | 'inventory-iq-monthly'
  | 'inventory-iq-yearly'
  | 'group-monthly'
  | 'group-yearly';

export type SubscriptionTierKey = 'watchlist' | 'dealer_edge' | 'inventory_iq' | 'group';
export type BillingInterval = 'month' | 'year';

export interface SubscriptionPlanMeta {
  id: SubscriptionPlanId;
  tier: SubscriptionTierKey;
  name: string;
  description: string;
  price: number; // dollars (display)
  interval: BillingInterval;
  trialDays?: number;
  features: string[];
}

export const SUBSCRIPTION_PLANS: SubscriptionPlanMeta[] = [
  // ─── Consumer ─────────────────────────────────────────────────────────────
  {
    id: 'watchlist-monthly',
    tier: 'watchlist',
    name: 'Watchlist Lite',
    description: 'Active buyers tracking a shortlist',
    price: 9,
    interval: 'month',
    trialDays: 7,
    features: [
      'Unlimited price-drop alerts',
      'Sold-price exact reveal on saved cars',
      'Market trend dashboard',
      '1 Vehicle Intelligence Report per month included',
      'Cancel anytime',
    ],
  },
  {
    id: 'watchlist-yearly',
    tier: 'watchlist',
    name: 'Watchlist Lite (Yearly)',
    description: '2 months free vs monthly',
    price: 90,
    interval: 'year',
    trialDays: 7,
    features: ['Everything in monthly', 'Save $18/year'],
  },

  // ─── Dealer ───────────────────────────────────────────────────────────────
  {
    id: 'edge-monthly',
    tier: 'dealer_edge',
    name: 'Dealer Edge',
    description: 'Single-location used-car dealers',
    price: 499,
    interval: 'month',
    trialDays: 14,
    features: [
      'Real-time market dashboard for every car in stock',
      '"You\'re $X over market" alerts',
      'Days-to-sell forecast per vehicle',
      'Restock recommendations from auction inventory',
      'Up to 100 vehicles tracked',
    ],
  },
  {
    id: 'edge-yearly',
    tier: 'dealer_edge',
    name: 'Dealer Edge (Yearly)',
    description: '2 months free vs monthly',
    price: 4_990,
    interval: 'year',
    trialDays: 14,
    features: ['Everything in monthly', 'Save $998/year'],
  },
  {
    id: 'inventory-iq-monthly',
    tier: 'inventory_iq',
    name: 'Inventory IQ',
    description: 'Multi-brand dealers running 100–400 cars',
    price: 1_499,
    interval: 'month',
    trialDays: 14,
    features: [
      'Everything in Dealer Edge',
      'Bulk PPSR + batch valuation',
      'Dealer-to-dealer trade matching',
      'Lead routing from the consumer surface',
      'Up to 500 vehicles tracked',
    ],
  },
  {
    id: 'inventory-iq-yearly',
    tier: 'inventory_iq',
    name: 'Inventory IQ (Yearly)',
    description: '2 months free vs monthly',
    price: 14_990,
    interval: 'year',
    trialDays: 14,
    features: ['Everything in monthly', 'Save $2,998/year'],
  },
  {
    id: 'group-monthly',
    tier: 'group',
    name: 'Group',
    description: 'Dealer groups + franchises',
    price: 2_999,
    interval: 'month',
    features: [
      'Everything in Inventory IQ',
      'Multi-location consolidation',
      'Branded consumer microsite',
      'Full API access (50k calls/mo)',
      'Dedicated account manager',
    ],
  },
  {
    id: 'group-yearly',
    tier: 'group',
    name: 'Group (Yearly)',
    description: '2 months free vs monthly',
    price: 29_990,
    interval: 'year',
    features: ['Everything in monthly', 'Save $5,998/year'],
  },
];

// One-off SKUs (not subscriptions)
export const ONE_OFF_SKUS = {
  report: {
    id: 'report-one-off',
    name: 'Vehicle Intelligence Report',
    price: 19, // dollars
    priceCents: 1900,
    description: 'PPSR + NEVDIS + market value + negotiation guidance, branded PDF.',
  },
} as const;
