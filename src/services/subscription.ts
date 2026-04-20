import { db } from '../config/database';
import { users, reports } from '../db/schema';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import {
  STRIPE_WEBHOOK_EVENTS,
  createCheckoutSession,
  createBillingPortalSession,
  getSubscription,
  SUBSCRIPTION_PLANS,
  ONE_OFF_SKUS,
  type SubscriptionTierKey,
  type BillingInterval,
} from '../config/stripe';
import { STRIPE_PRICES, isStripeConfigured, isBillingFullyWired } from '../config/env';
import { updateUserSubscription } from './auth';
import { AppError } from '../middleware/error-handler';
import { runReport } from './reports';
import type { SubscriptionTier, SubscriptionStatus } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
//  Plans + price-id resolution
// ─────────────────────────────────────────────────────────────────────────────

export const getSubscriptionPlans = () => {
  return SUBSCRIPTION_PLANS.map((plan) => ({
    ...plan,
    stripe_price_id: getPriceIdForPlan(plan.tier, plan.interval),
  }));
};

export function getPriceIdForPlan(tier: SubscriptionTierKey, interval: BillingInterval): string {
  const intervalKey = interval === 'month' ? 'monthly' : 'yearly';
  switch (tier) {
    case 'watchlist':
      return STRIPE_PRICES.watchlist[intervalKey];
    case 'dealer_edge':
      return STRIPE_PRICES.dealer_edge[intervalKey];
    case 'inventory_iq':
      return STRIPE_PRICES.inventory_iq[intervalKey];
    case 'group':
      return STRIPE_PRICES.group[intervalKey];
    default:
      return '';
  }
}

/** Reverse lookup: which canonical tier does this Stripe price id belong to? */
function tierFromPriceId(priceId: string | undefined | null): SubscriptionTier | null {
  if (!priceId) return null;
  const map: Array<{ id: string; tier: SubscriptionTier }> = [
    { id: STRIPE_PRICES.watchlist.monthly, tier: 'watchlist' },
    { id: STRIPE_PRICES.watchlist.yearly, tier: 'watchlist' },
    { id: STRIPE_PRICES.dealer_edge.monthly, tier: 'dealer_edge' },
    { id: STRIPE_PRICES.dealer_edge.yearly, tier: 'dealer_edge' },
    { id: STRIPE_PRICES.inventory_iq.monthly, tier: 'inventory_iq' },
    { id: STRIPE_PRICES.inventory_iq.yearly, tier: 'inventory_iq' },
    { id: STRIPE_PRICES.group.monthly, tier: 'group' },
    { id: STRIPE_PRICES.group.yearly, tier: 'group' },
    // legacy aliases (resolve through env aliases in env.ts)
    { id: STRIPE_PRICES.pro.monthly, tier: 'pro' },
    { id: STRIPE_PRICES.pro.yearly, tier: 'pro' },
    { id: STRIPE_PRICES.dealer.monthly, tier: 'dealer' },
    { id: STRIPE_PRICES.dealer.yearly, tier: 'dealer' },
  ];
  return map.find((m) => m.id && m.id === priceId)?.tier ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Subscription checkout (recurring)
// ─────────────────────────────────────────────────────────────────────────────

export const createCheckout = async (
  userId: string,
  tier: SubscriptionTierKey,
  interval: BillingInterval,
  successUrl: string,
  cancelUrl: string,
): Promise<{ sessionId: string; url: string }> => {
  if (!isStripeConfigured()) {
    throw new AppError(
      'Billing is not yet configured on this environment. Try again shortly.',
      503,
      'STRIPE_NOT_CONFIGURED',
    );
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  if (!user.stripe_customer_id) {
    throw new AppError('Stripe customer not found', 400, 'STRIPE_ERROR');
  }

  const priceId = getPriceIdForPlan(tier, interval);
  if (!priceId) {
    throw new AppError(
      `No Stripe price configured for ${tier}/${interval}. Run \`npm run stripe:setup\` and set the env var.`,
      503,
      'PRICE_ID_MISSING',
    );
  }

  const plan = SUBSCRIPTION_PLANS.find((p) => p.tier === tier && p.interval === interval);
  const session = await createCheckoutSession(user.stripe_customer_id, priceId, successUrl, cancelUrl, {
    mode: 'subscription',
    trialDays: plan?.trialDays,
    metadata: { user_id: userId, tier, interval, kind: 'subscription' },
  });

  return { sessionId: session.id, url: session.url! };
};

// ─────────────────────────────────────────────────────────────────────────────
//  One-off Vehicle Intelligence Report checkout
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportLookup {
  vin?: string;
  rego?: string;
  state?: string;
}

export const createReportCheckout = async (
  userId: string | null,
  lookup: ReportLookup,
  successUrl: string,
  cancelUrl: string,
  customerEmail?: string,
): Promise<{ sessionId: string; url: string; reportId: string }> => {
  if (!isStripeConfigured()) {
    throw new AppError(
      'Billing is not yet configured on this environment.',
      503,
      'STRIPE_NOT_CONFIGURED',
    );
  }
  const priceId = STRIPE_PRICES.report;
  if (!priceId) {
    throw new AppError(
      'STRIPE_PRICE_REPORT not configured. Run `npm run stripe:setup` and set the env var.',
      503,
      'PRICE_ID_MISSING',
    );
  }

  // Pre-create a pending report so the webhook can fulfil by id (idempotent)
  const [reportRow] = await db
    .insert(reports)
    .values({
      user_id: userId ?? null,
      requested_vin: lookup.vin ?? null,
      requested_rego: lookup.rego ?? null,
      requested_state: lookup.state ?? null,
      status: 'pending',
      price_cents: ONE_OFF_SKUS.report.priceCents,
    })
    .returning();
  if (!reportRow) throw new AppError('Failed to create report row', 500, 'DB_INSERT_FAILED');

  // Resolve customer (optional — guests can checkout via email)
  let customerId: string | undefined;
  if (userId) {
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    customerId = user?.stripe_customer_id ?? undefined;
  }

  const session = await createCheckoutSession(
    customerId ?? '',
    priceId,
    `${successUrl}?report_id=${reportRow.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl,
    {
      mode: 'payment',
      metadata: {
        kind: 'report',
        report_id: reportRow.id,
        user_id: userId ?? '',
        vin: lookup.vin ?? '',
        rego: lookup.rego ?? '',
        state: lookup.state ?? '',
      },
    },
  );

  return { sessionId: session.id, url: session.url!, reportId: reportRow.id };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Billing portal + status
// ─────────────────────────────────────────────────────────────────────────────

export const createPortalSession = async (
  userId: string,
  returnUrl: string,
): Promise<{ url: string }> => {
  if (!isStripeConfigured()) {
    throw new AppError('Billing not configured', 503, 'STRIPE_NOT_CONFIGURED');
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.stripe_customer_id) {
    throw new AppError('No subscription found', 404, 'NO_SUBSCRIPTION');
  }
  const session = await createBillingPortalSession(user.stripe_customer_id, returnUrl);
  return { url: session.url };
};

export const getSubscriptionStatus = async (userId: string) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      subscription_tier: true,
      subscription_status: true,
      subscription_expires_at: true,
      stripe_subscription_id: true,
    },
  });
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  let stripeSubscription: Stripe.Subscription | null = null;
  if (user.stripe_subscription_id && isStripeConfigured()) {
    try {
      stripeSubscription = await getSubscription(user.stripe_subscription_id);
    } catch (error) {
      console.error('Error fetching Stripe subscription:', error);
    }
  }

  return {
    tier: user.subscription_tier,
    status: user.subscription_status,
    expires_at: user.subscription_expires_at,
    stripe_status: stripeSubscription?.status || null,
    current_period_end: stripeSubscription?.current_period_end
      ? new Date(stripeSubscription.current_period_end * 1000)
      : null,
    billing_fully_wired: isBillingFullyWired(),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
//  Webhook event handler
// ─────────────────────────────────────────────────────────────────────────────

export const handleWebhookEvent = async (event: Stripe.Event): Promise<void> => {
  console.log(`[stripe webhook] ${event.type} (${event.id})`);

  switch (event.type) {
    case STRIPE_WEBHOOK_EVENTS.CHECKOUT_COMPLETED:
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case STRIPE_WEBHOOK_EVENTS.PAYMENT_INTENT_SUCCEEDED:
      await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
      break;
    case STRIPE_WEBHOOK_EVENTS.INVOICE_PAID:
      await handleInvoicePaid(event.data.object as Stripe.Invoice);
      break;
    case STRIPE_WEBHOOK_EVENTS.INVOICE_PAYMENT_FAILED:
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
      break;
    case STRIPE_WEBHOOK_EVENTS.SUBSCRIPTION_DELETED:
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;
    case STRIPE_WEBHOOK_EVENTS.SUBSCRIPTION_UPDATED:
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
      break;
    default:
      console.log(`[stripe webhook] unhandled type: ${event.type}`);
  }
};

const handleCheckoutCompleted = async (session: Stripe.Checkout.Session): Promise<void> => {
  const kind = (session.metadata?.kind as 'subscription' | 'report' | undefined) ?? 'subscription';

  // ── One-off Vehicle Intelligence Report ────────────────────────────────
  if (kind === 'report') {
    const reportId = session.metadata?.report_id;
    if (!reportId) {
      console.error('[stripe webhook] report checkout completed without report_id metadata');
      return;
    }
    const piId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
    if (piId) {
      await db
        .update(reports)
        .set({ stripe_payment_intent: piId })
        .where(eq(reports.id, reportId));
    }
    // Kick off fulfilment (PPSR + NEVDIS + market value).
    runReport(reportId).catch((err) => {
      console.error(`[stripe webhook] runReport ${reportId} failed:`, err);
    });
    return;
  }

  // ── Subscription ───────────────────────────────────────────────────────
  if (!session.customer || !session.subscription) {
    console.error('[stripe webhook] subscription checkout missing customer/subscription');
    return;
  }
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;

  const user = await db.query.users.findFirst({
    where: eq(users.stripe_customer_id, customerId),
  });
  if (!user) {
    console.error(`[stripe webhook] no user for customer: ${customerId}`);
    return;
  }

  const subscription = await getSubscription(subscriptionId);
  const priceId = subscription.items.data[0]?.price.id;
  const tier = (tierFromPriceId(priceId) ?? user.subscription_tier) as SubscriptionTier;

  await updateUserSubscription(user.id, {
    subscription_tier: tier,
    stripe_subscription_id: subscriptionId,
    subscription_status: 'active',
    subscription_expires_at: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
  });
  console.log(`[stripe webhook] subscription activated user=${user.id} tier=${tier}`);
};

const handlePaymentIntentSucceeded = async (pi: Stripe.PaymentIntent): Promise<void> => {
  // Fallback fulfilment path for report purchases (in case checkout.session.completed
  // arrived before payment_intent was finalized).
  const reportId = pi.metadata?.report_id;
  if (reportId) {
    const existing = await db.query.reports.findFirst({ where: eq(reports.id, reportId) });
    if (existing && existing.status === 'pending') {
      await db
        .update(reports)
        .set({ stripe_payment_intent: pi.id })
        .where(eq(reports.id, reportId));
      runReport(reportId).catch((err) => {
        console.error(`[stripe webhook] PI fallback runReport ${reportId} failed:`, err);
      });
    }
  }
};

const handleInvoicePaid = async (invoice: Stripe.Invoice): Promise<void> => {
  if (!invoice.subscription) return;
  const subscriptionId = invoice.subscription as string;
  const subscription = await getSubscription(subscriptionId);
  const user = await db.query.users.findFirst({
    where: eq(users.stripe_subscription_id, subscriptionId),
  });
  if (!user) return;
  await updateUserSubscription(user.id, {
    subscription_status: 'active',
    subscription_expires_at: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
  });
  console.log(`[stripe webhook] invoice paid user=${user.id}`);
};

const handleInvoicePaymentFailed = async (invoice: Stripe.Invoice): Promise<void> => {
  if (!invoice.subscription) return;
  const subscriptionId = invoice.subscription as string;
  const user = await db.query.users.findFirst({
    where: eq(users.stripe_subscription_id, subscriptionId),
  });
  if (!user) return;
  await updateUserSubscription(user.id, { subscription_status: 'past_due' });
  console.log(`[stripe webhook] invoice payment failed user=${user.id}`);
};

const handleSubscriptionDeleted = async (subscription: Stripe.Subscription): Promise<void> => {
  const user = await db.query.users.findFirst({
    where: eq(users.stripe_subscription_id, subscription.id),
  });
  if (!user) return;
  await updateUserSubscription(user.id, {
    subscription_tier: 'free',
    subscription_status: 'cancelled',
    stripe_subscription_id: null,
    subscription_expires_at: null,
  });
  console.log(`[stripe webhook] subscription cancelled user=${user.id}`);
};

const handleSubscriptionUpdated = async (subscription: Stripe.Subscription): Promise<void> => {
  const user = await db.query.users.findFirst({
    where: eq(users.stripe_subscription_id, subscription.id),
  });
  if (!user) return;

  const priceId = subscription.items.data[0]?.price.id;
  const tier = (tierFromPriceId(priceId) ?? user.subscription_tier) as SubscriptionTier;

  let status: SubscriptionStatus | null = user.subscription_status;
  if (subscription.status === 'active') status = 'active';
  else if (subscription.status === 'canceled') status = 'cancelled';
  else if (subscription.status === 'past_due') status = 'past_due';
  else if (subscription.status === 'trialing') status = 'trialing';
  else if (subscription.status === 'paused') status = 'paused';

  await updateUserSubscription(user.id, {
    subscription_tier: tier,
    subscription_status: status,
    subscription_expires_at: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
  });
  console.log(`[stripe webhook] subscription updated user=${user.id} tier=${tier} status=${status}`);
};
