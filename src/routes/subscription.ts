import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getSubscriptionPlans,
  createCheckout,
  createPortalSession,
  getSubscriptionStatus,
  handleWebhookEvent,
} from '../services/subscription';
import { constructWebhookEvent } from '../config/stripe';
import { apiLimiter, webhookLimiter } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/auth';
import { asyncHandler, AppError } from '../middleware/error-handler';
import { env } from '../config/env';

const router = Router();

// Validation schemas
const checkoutSchema = z.object({
  tier: z.enum(['pro', 'dealer']),
  interval: z.enum(['month', 'year']),
});

// GET /api/subscription/plans
router.get(
  '/plans',
  apiLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    const plans = getSubscriptionPlans();
    res.json({ plans });
  })
);

// POST /api/subscription/checkout
router.post(
  '/checkout',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { tier, interval } = checkoutSchema.parse(req.body);

    const successUrl = `${env.FRONTEND_URL}/subscription/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${env.FRONTEND_URL}/pricing`;

    const checkout = await createCheckout(
      req.user!.id,
      tier,
      interval,
      successUrl,
      cancelUrl
    );

    res.json({
      sessionId: checkout.sessionId,
      url: checkout.url,
    });
  })
);

// GET /api/subscription/portal
router.get(
  '/portal',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const returnUrl = `${env.FRONTEND_URL}/account`;

    const portal = await createPortalSession(req.user!.id, returnUrl);

    res.json({ url: portal.url });
  })
);

// GET /api/subscription/status
router.get(
  '/status',
  requireAuth,
  apiLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const status = await getSubscriptionStatus(req.user!.id);
    res.json(status);
  })
);

// POST /api/subscription/webhook
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

    // Handle the event
    await handleWebhookEvent(event);

    res.json({ received: true });
  })
);

export default router;
