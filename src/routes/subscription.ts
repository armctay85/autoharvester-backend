import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getSubscriptionPlans,
  createCheckout,
  createGuestSubscriptionCheckout,
  createReportCheckout,
  createPortalSession,
  getSubscriptionStatus,
  handleWebhookEvent,
} from '../services/subscription';
import { constructWebhookEvent } from '../config/stripe';
import { apiLimiter, webhookLimiter } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { env, isStripeConfigured, isBillingFullyWired } from '../config/env';

const router = Router();

// ─── Validation schemas ─────────────────────────────────────────────────────

const checkoutSchema = z.object({
  // Canonical v2 tier names + 'pro'/'dealer' kept for legacy clients
  tier: z.enum(['watchlist', 'dealer_edge', 'inventory_iq', 'group', 'pro', 'dealer']),
  interval: z.enum(['month', 'year']),
});

const guestCheckoutSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  // Only the canonical 5-SKU set is valid for guest flow — we don't accept
  // legacy `pro`/`dealer` aliases here so the marketing site and backend
  // can never diverge on published pricing.
  tier: z.enum(['watchlist', 'dealer_edge', 'inventory_iq', 'group']),
  interval: z.enum(['month', 'year']),
});

const reportCheckoutSchema = z
  .object({
    vin: z.string().trim().min(11).max(17).optional(),
    rego: z.string().trim().min(2).max(16).optional(),
    state: z.string().trim().min(2).max(4).optional(),
  })
  .refine((d) => Boolean(d.vin || d.rego), { message: 'Provide either vin or rego' });

// ─── Plans + billing-status ─────────────────────────────────────────────────

router.get(
  '/plans',
  apiLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const plans = getSubscriptionPlans();
    res.json({
      plans,
      billing: {
        stripe_configured: isStripeConfigured(),
        fully_wired: isBillingFullyWired(),
      },
    });
  }),
);

// ─── Subscription checkout ──────────────────────────────────────────────────

router.post(
  '/checkout',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = checkoutSchema.parse(req.body);
    // Map legacy tier names to canonical
    const tier =
      parsed.tier === 'pro'
        ? 'watchlist'
        : parsed.tier === 'dealer'
        ? 'dealer_edge'
        : parsed.tier;

    const successUrl = `${env.FRONTEND_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${env.FRONTEND_URL}/pricing`;

    const checkout = await createCheckout(req.user!.id, tier, parsed.interval, successUrl, cancelUrl);
    res.json({ sessionId: checkout.sessionId, url: checkout.url });
  }),
);

// ─── Guest subscription checkout (no auth required) ────────────────────────
//
// Accepts { email, tier, interval } and returns a Stripe Checkout URL. The
// webhook handler provisions (or links) the matching user row on completion.

router.post(
  '/checkout/guest',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, tier, interval } = guestCheckoutSchema.parse(req.body);
    const successUrl = `${env.FRONTEND_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}&tier=${tier}&interval=${interval}`;
    const cancelUrl = `${env.FRONTEND_URL}/pricing`;
    const checkout = await createGuestSubscriptionCheckout(email, tier, interval, successUrl, cancelUrl);
    res.json({ sessionId: checkout.sessionId, url: checkout.url });
  }),
);

// ─── One-off Vehicle Intelligence Report checkout ───────────────────────────

router.post(
  '/checkout/report',
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const lookup = reportCheckoutSchema.parse(req.body);
    const userId = req.user?.id ?? null;

    const successUrl = `${env.FRONTEND_URL}/report/ready`;
    const cancelUrl = `${env.FRONTEND_URL}/vehicle-history-report`;

    const checkout = await createReportCheckout(userId, lookup, successUrl, cancelUrl);
    res.json({
      sessionId: checkout.sessionId,
      url: checkout.url,
      reportId: checkout.reportId,
    });
  }),
);

// ─── Billing portal ─────────────────────────────────────────────────────────

router.get(
  '/portal',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const returnUrl = `${env.FRONTEND_URL}/account`;
    const portal = await createPortalSession(req.user!.id, returnUrl);
    res.json({ url: portal.url });
  }),
);

// ─── Subscription status ────────────────────────────────────────────────────

router.get(
  '/status',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const status = await getSubscriptionStatus(req.user!.id);
    res.json(status);
  }),
);

// ─── Webhook ────────────────────────────────────────────────────────────────

router.post(
  '/webhook',
  webhookLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      throw new AppError('Missing Stripe signature', 400, 'INVALID_SIGNATURE');
    }
    let event;
    try {
      event = constructWebhookEvent(req.body, signature);
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      throw new AppError('Invalid signature', 400, 'INVALID_SIGNATURE');
    }
    await handleWebhookEvent(event);
    res.json({ received: true });
  }),
);

export default router;
