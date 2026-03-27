import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import passport from 'passport';
import { registerUser, requestPasswordReset } from '../services/auth';
import { authLimiter } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/error-handler';

const router = Router();

// Validation schemas
const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  first_name: z.string().min(1, 'First name is required'),
  last_name: z.string().min(1, 'Last name is required'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

// POST /api/auth/register
router.post(
  '/register',
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const data = registerSchema.parse(req.body);
    
    const user = await registerUser(data);

    // Log the user in after registration
    req.login(
      {
        id: user.id,
        email: user.email,
        subscription_tier: user.subscription_tier,
        subscription_status: user.subscription_status,
      },
      (err: Error | null) => {
        if (err) {
          res.status(500).json({ error: 'Login failed after registration' });
          return;
        }

        res.status(201).json({
          user: {
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            subscription_tier: user.subscription_tier,
            subscription_status: user.subscription_status,
          },
        });
      }
    );
  })
);

// POST /api/auth/login
router.post(
  '/login',
  authLimiter,
  (req: Request, res: Response, next: NextFunction) => {
    // Validate input first
    loginSchema.parse(req.body);
    next();
  },
  passport.authenticate('local'),
  (req: Request, res: Response) => {
    res.json({
      user: {
        id: req.user!.id,
        email: req.user!.email,
        subscription_tier: req.user!.subscription_tier,
        subscription_status: req.user!.subscription_status,
      },
    });
  }
);

// POST /api/auth/logout
router.post('/logout', requireAuth, (req: Request, res: Response, next: NextFunction) => {
  req.logout((err) => {
    if (err) return next(err);
    res.json({ message: 'Logged out successfully' });
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({
    user: {
      id: req.user!.id,
      email: req.user!.email,
      subscription_tier: req.user!.subscription_tier,
      subscription_status: req.user!.subscription_status,
    },
  });
});

// POST /api/auth/forgot-password
router.post(
  '/forgot-password',
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    
    await requestPasswordReset(email);

    // Always return success to prevent email enumeration
    res.json({
      message: 'If an account exists with this email, a password reset link has been sent.',
    });
  })
);

// POST /api/auth/reset-password
router.post(
  '/reset-password',
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { token, password } = resetPasswordSchema.parse(req.body);

    // In production: validate token, get userId from token
    // For now, placeholder implementation
    console.log('Reset password attempt:', { token: token.slice(0, 8), passwordLength: password.length });

    res.json({ message: 'Password has been reset successfully' });
  })
);

export default router;
