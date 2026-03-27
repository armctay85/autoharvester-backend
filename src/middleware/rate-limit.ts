import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { env } from '../config/env';

// Extend Express Request to include rateLimit
declare global {
  namespace Express {
    interface Request {
      rateLimit?: {
        limit: number;
        current: number;
        remaining: number;
        resetTime: Date;
      };
    }
  }
}

// General API rate limiter: 100 requests per minute
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res) => {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'You have exceeded the rate limit. Please try again later.',
      retryAfter: req.rateLimit?.resetTime 
        ? Math.ceil(req.rateLimit.resetTime.getTime() / 1000)
        : 60,
    });
  },
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise use IP
    return req.user?.id || req.ip || 'unknown';
  },
  skip: () => {
    // Skip rate limiting in development
    return env.NODE_ENV === 'development';
  },
});

// Auth rate limiter: 5 requests per minute (more strict)
export const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res) => {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many authentication attempts. Please try again in a minute.',
      retryAfter: req.rateLimit?.resetTime 
        ? Math.ceil(req.rateLimit.resetTime.getTime() / 1000)
        : 60,
    });
  },
  keyGenerator: (req) => {
    return req.ip || 'unknown';
  },
  skipSuccessfulRequests: false,
});

// Stripe webhook rate limiter: 50 requests per minute
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Webhook rate limit exceeded',
    });
  },
});

// Search rate limiter based on subscription tier
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: (req) => {
    // Return max searches per minute based on tier
    const tier = req.user?.subscription_tier || 'free';
    const tierLimits: Record<string, number> = {
      free: 5,
      pro: 50,
      dealer: 100,
      enterprise: 200,
    };
    return tierLimits[tier] || 5;
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.id || req.ip || 'unknown';
  },
  handler: (req, res) => {
    const tier = req.user?.subscription_tier || 'free';
    res.status(429).json({
      error: 'Search limit exceeded',
      message: `You have reached your search limit for this minute. Upgrade to increase your limits.`,
      tier,
    });
  },
});
