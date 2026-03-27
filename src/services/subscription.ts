import { db } from '../config/database';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import {
  stripe,
  STRIPE_WEBHOOK_EVENTS,
  createCheckoutSession,
  createBillingPortalSession,
  getSubscription,
  SUBSCRIPTION_PLANS,
} from '../config/stripe';
import { STRIPE_PRICES } from '../config/env';
import { updateUserSubscription } from './auth';
import { AppError } from '../middleware/error-handler';

// Get available subscription plans
export const getSubscriptionPlans = () => {
  return SUBSCRIPTION_PLANS.map((plan) => ({
    ...plan,
    stripe_price_id: getPriceIdForPlan(plan.tier, plan.interval),
  }));
};

// Get Stripe price ID for plan
const getPriceIdForPlan = (
  tier: 'pro' | 'dealer',
  interval: 'month' | 'year'
): string => {
  const intervalKey = interval === 'month' ? 'monthly' : 'yearly';
  return STRIPE_PRICES[tier][intervalKey];
};

// Create checkout session for user
export const createCheckout = async (
  userId: string,
  tier: 'pro' | 'dealer',
  interval: 'month' | 'year',
  successUrl: string,
  cancelUrl: string
): Promise<{ sessionId: string; url: string }> => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!user) {
    throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  }

  if (!user.stripe_customer_id) {
    throw new AppError('Stripe customer not found', 400, 'STRIPE_ERROR');
  }

  const priceId = getPriceIdForPlan(tier, interval);
  
  const session = await createCheckoutSession(
    user.stripe_customer_id,
    priceId,
    successUrl,
    cancelUrl
  );

  return {
    sessionId: session.id,
    url: session.url!,
  };
};

// Create billing portal session
export const createPortalSession = async (
  userId: string,
  returnUrl: string
): Promise<{ url: string }> => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (!user?.stripe_customer_id) {
    throw new AppError('No subscription found', 404, 'NO_SUBSCRIPTION');
  }

  const session = await createBillingPortalSession(
    user.stripe_customer_id,
    returnUrl
  );

  return { url: session.url };
};

// Get user's subscription status
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

  if (!user) {
    throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  }

  let stripeSubscription = null;
  if (user.stripe_subscription_id) {
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
  };
};

// Handle Stripe webhook events
export const handleWebhookEvent = async (event: Stripe.Event): Promise<void> => {
  console.log(`Processing Stripe webhook: ${event.type}`);

  switch (event.type) {
    case STRIPE_WEBHOOK_EVENTS.CHECKOUT_COMPLETED:
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
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
      console.log(`Unhandled event type: ${event.type}`);
  }
};

// Handle checkout.session.completed
const handleCheckoutCompleted = async (session: Stripe.Checkout.Session): Promise<void> => {
  if (!session.customer || !session.subscription) {
    console.error('Missing customer or subscription in checkout session');
    return;
  }

  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;

  // Find user by Stripe customer ID
  const user = await db.query.users.findFirst({
    where: eq(users.stripe_customer_id, customerId),
  });

  if (!user) {
    console.error(`User not found for customer: ${customerId}`);
    return;
  }

  // Get subscription details from Stripe
  const subscription = await getSubscription(subscriptionId);
  const priceId = subscription.items.data[0]?.price.id;

  // Determine tier from price ID
  let tier: 'pro' | 'dealer' = 'pro';
  if (priceId === STRIPE_PRICES.dealer.monthly || priceId === STRIPE_PRICES.dealer.yearly) {
    tier = 'dealer';
  }

  // Update user subscription
  await updateUserSubscription(user.id, {
    subscription_tier: tier,
    stripe_subscription_id: subscriptionId,
    subscription_status: 'active',
    subscription_expires_at: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
  });

  console.log(`Subscription activated for user ${user.id}, tier: ${tier}`);
};

// Handle invoice.paid
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

  console.log(`Invoice paid for user ${user.id}`);
};

// Handle invoice.payment_failed
const handleInvoicePaymentFailed = async (invoice: Stripe.Invoice): Promise<void> => {
  if (!invoice.subscription) return;

  const subscriptionId = invoice.subscription as string;

  const user = await db.query.users.findFirst({
    where: eq(users.stripe_subscription_id, subscriptionId),
  });

  if (!user) return;

  await updateUserSubscription(user.id, {
    subscription_status: 'past_due',
  });

  console.log(`Payment failed for user ${user.id}`);
};

// Handle customer.subscription.deleted
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

  console.log(`Subscription cancelled for user ${user.id}`);
};

// Handle customer.subscription.updated
const handleSubscriptionUpdated = async (subscription: Stripe.Subscription): Promise<void> => {
  const user = await db.query.users.findFirst({
    where: eq(users.stripe_subscription_id, subscription.id),
  });

  if (!user) return;

  const priceId = subscription.items.data[0]?.price.id;

  // Determine tier from price ID
  let tier: 'free' | 'pro' | 'dealer' | 'enterprise' = user.subscription_tier;
  if (priceId === STRIPE_PRICES.pro.monthly || priceId === STRIPE_PRICES.pro.yearly) {
    tier = 'pro';
  } else if (priceId === STRIPE_PRICES.dealer.monthly || priceId === STRIPE_PRICES.dealer.yearly) {
    tier = 'dealer';
  }

  let status: 'active' | 'cancelled' | 'past_due' | null = user.subscription_status;
  if (subscription.status === 'active') {
    status = 'active';
  } else if (subscription.status === 'canceled') {
    status = 'cancelled';
  } else if (subscription.status === 'past_due') {
    status = 'past_due';
  }

  await updateUserSubscription(user.id, {
    subscription_tier: tier,
    subscription_status: status,
    subscription_expires_at: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : null,
  });

  console.log(`Subscription updated for user ${user.id}, tier: ${tier}, status: ${status}`);
};
