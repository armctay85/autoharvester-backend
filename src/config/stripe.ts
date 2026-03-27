import Stripe from 'stripe';
import { env } from './env';

// Initialize Stripe client
export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

// Webhook event types we handle
export const STRIPE_WEBHOOK_EVENTS = {
  CHECKOUT_COMPLETED: 'checkout.session.completed',
  INVOICE_PAID: 'invoice.paid',
  INVOICE_PAYMENT_FAILED: 'invoice.payment_failed',
  SUBSCRIPTION_DELETED: 'customer.subscription.deleted',
  SUBSCRIPTION_UPDATED: 'customer.subscription.updated',
} as const;

// Construct webhook event with signature verification
export const constructWebhookEvent = (
  payload: Buffer,
  signature: string
): Stripe.Event => {
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    env.STRIPE_WEBHOOK_SECRET
  );
};

// Create a Stripe customer
export const createCustomer = async (
  email: string,
  name: string
): Promise<Stripe.Customer> => {
  return stripe.customers.create({
    email,
    name,
  });
};

// Create a checkout session for subscription
export const createCheckoutSession = async (
  customerId: string,
  priceId: string,
  successUrl: string,
  cancelUrl: string
): Promise<Stripe.Checkout.Session> => {
  return stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    mode: 'subscription',
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      trial_period_days: 7, // 7-day free trial
    },
  });
};

// Create billing portal session
export const createBillingPortalSession = async (
  customerId: string,
  returnUrl: string
): Promise<Stripe.BillingPortal.Session> => {
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
};

// Cancel subscription
export const cancelSubscription = async (
  subscriptionId: string
): Promise<Stripe.Subscription> => {
  return stripe.subscriptions.cancel(subscriptionId);
};

// Get subscription details
export const getSubscription = async (
  subscriptionId: string
): Promise<Stripe.Subscription> => {
  return stripe.subscriptions.retrieve(subscriptionId);
};

// Subscription plans metadata
export const SUBSCRIPTION_PLANS = [
  {
    id: 'pro-monthly',
    name: 'Pro Monthly',
    description: 'Perfect for individual car buyers',
    price: 29,
    interval: 'month' as const,
    tier: 'pro' as const,
    features: [
      'View sold car prices',
      '50 searches per month',
      '10 price alerts',
      'Export data to CSV',
      '7-day free trial',
    ],
  },
  {
    id: 'pro-yearly',
    name: 'Pro Yearly',
    description: 'Save 2 months with yearly billing',
    price: 290,
    interval: 'year' as const,
    tier: 'pro' as const,
    features: [
      'View sold car prices',
      '50 searches per month',
      '10 price alerts',
      'Export data to CSV',
      '7-day free trial',
      'Save $58/year',
    ],
  },
  {
    id: 'dealer-monthly',
    name: 'Dealer Monthly',
    description: 'For automotive professionals',
    price: 299,
    interval: 'month' as const,
    tier: 'dealer' as const,
    features: [
      'Everything in Pro',
      '500 searches per month',
      '100 price alerts',
      'Bulk data import',
      'Admin dashboard',
      'Priority support',
    ],
  },
  {
    id: 'dealer-yearly',
    name: 'Dealer Yearly',
    description: 'Best value for dealers',
    price: 2990,
    interval: 'year' as const,
    tier: 'dealer' as const,
    features: [
      'Everything in Pro',
      '500 searches per month',
      '100 price alerts',
      'Bulk data import',
      'Admin dashboard',
      'Priority support',
      'Save $598/year',
    ],
  },
];
