import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { db } from '../config/database';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { env, getTierConfig } from '../config/env';
import type { SubscriptionStatus, SubscriptionTier } from '../types';
void env;

// Extend Express Request type
declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      subscription_tier: SubscriptionTier;
      subscription_status: SubscriptionStatus | null;
    }
  }
}

// Initialize Passport with local strategy
export const initializePassport = (): passport.Authenticator => {
  passport.use(
    new LocalStrategy(
      { usernameField: 'email' },
      async (email, password, done) => {
        try {
          const user = await db.query.users.findFirst({
            where: eq(users.email, email.toLowerCase().trim()),
          });

          if (!user) {
            return done(null, false, { message: 'Invalid email or password' });
          }

          const isValidPassword = await bcrypt.compare(password, user.password_hash);

          if (!isValidPassword) {
            return done(null, false, { message: 'Invalid email or password' });
          }

          // Update last login
          await db
            .update(users)
            .set({ last_login_at: new Date() })
            .where(eq(users.id, user.id));

          return done(null, {
            id: user.id,
            email: user.email,
            subscription_tier: user.subscription_tier,
            subscription_status: user.subscription_status,
          });
        } catch (error) {
          return done(error);
        }
      }
    )
  );

  passport.serializeUser((user: Express.User, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await db.query.users.findFirst({
        where: eq(users.id, id),
        columns: {
          id: true,
          email: true,
          subscription_tier: true,
          subscription_status: true,
        },
      });

      if (!user) {
        return done(null, false);
      }

      done(null, user);
    } catch (error) {
      done(error);
    }
  });

  return passport;
};

// Middleware to check if user is authenticated
export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized', message: 'Please log in to access this resource' });
};

// Middleware to check subscription tier
export const requireTier = (...allowedTiers: Array<SubscriptionTier>) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: 'Unauthorized', message: 'Please log in' });
      return;
    }

    const userTier = req.user?.subscription_tier || 'free';
    
    if (!allowedTiers.includes(userTier)) {
      res.status(403).json({ 
        error: 'Forbidden', 
        message: 'This feature requires a higher subscription tier',
        required: allowedTiers,
        current: userTier,
      });
      return;
    }

    next();
  };
};

// Middleware to check if subscription is active
export const requireActiveSubscription = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'Unauthorized', message: 'Please log in' });
    return;
  }

  const tier = req.user?.subscription_tier || 'free';
  const status = req.user?.subscription_status;

  // Free tier doesn't need active subscription check
  if (tier === 'free') {
    return next();
  }

  // Paid tiers need active status
  if (status !== 'active') {
    res.status(403).json({ 
      error: 'Subscription inactive', 
      message: 'Your subscription is not active. Please update your payment method.',
      status,
    });
    return;
  }

  next();
};

// Middleware for admin/dealer access
export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'Unauthorized', message: 'Please log in' });
    return;
  }

  const tier = req.user?.subscription_tier || 'free';
  const tierConfig = getTierConfig(tier);
  const hasAdminAccess = tierConfig.hasAdminAccess || false;

  if (!hasAdminAccess) {
    res.status(403).json({ 
      error: 'Forbidden', 
      message: 'This feature requires Dealer or Enterprise subscription',
    });
    return;
  }

  next();
};

// Hash password with bcrypt (12 rounds)
export const hashPassword = async (password: string): Promise<string> => {
  return bcrypt.hash(password, 12);
};

// Compare password with hash
export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
  return bcrypt.compare(password, hash);
};
