import { db } from '../config/database';
import { users, NewUser } from '../db/schema';
import { eq } from 'drizzle-orm';
import { hashPassword, comparePassword } from '../middleware/auth';
import { createCustomer } from '../config/stripe';
import { AppError } from '../middleware/error-handler';
import { User } from '../types';

export interface RegisterInput {
  email: string;
  password: string;
  first_name: string;
  last_name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

// Register a new user
export const registerUser = async (input: RegisterInput): Promise<User> => {
  const { email, password, first_name, last_name } = input;

  // Check if email already exists
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase().trim()),
  });

  if (existingUser) {
    throw new AppError('Email already registered', 409, 'EMAIL_EXISTS');
  }

  // Hash password
  const password_hash = await hashPassword(password);

  // Create Stripe customer
  const stripeCustomer = await createCustomer(
    email.toLowerCase().trim(),
    `${first_name} ${last_name}`
  );

  // Create user
  const newUser: NewUser = {
    email: email.toLowerCase().trim(),
    password_hash,
    first_name,
    last_name,
    subscription_tier: 'free',
    stripe_customer_id: stripeCustomer.id,
    stripe_subscription_id: null,
    subscription_status: null,
    subscription_expires_at: null,
    last_login_at: null,
  };

  const result = await db.insert(users).values(newUser).returning();
  const createdUser = result[0];

  if (!createdUser) {
    throw new AppError('Failed to create user', 500, 'CREATE_FAILED');
  }

  return {
    id: createdUser.id,
    email: createdUser.email,
    password_hash: createdUser.password_hash,
    first_name: createdUser.first_name,
    last_name: createdUser.last_name,
    subscription_tier: createdUser.subscription_tier,
    stripe_customer_id: createdUser.stripe_customer_id,
    stripe_subscription_id: createdUser.stripe_subscription_id,
    subscription_status: createdUser.subscription_status,
    subscription_expires_at: createdUser.subscription_expires_at,
    created_at: createdUser.created_at,
    updated_at: createdUser.updated_at,
    last_login_at: createdUser.last_login_at,
  };
};

// Get user by ID
export const getUserById = async (id: string): Promise<User | null> => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, id),
  });

  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    password_hash: user.password_hash,
    first_name: user.first_name,
    last_name: user.last_name,
    subscription_tier: user.subscription_tier,
    stripe_customer_id: user.stripe_customer_id,
    stripe_subscription_id: user.stripe_subscription_id,
    subscription_status: user.subscription_status,
    subscription_expires_at: user.subscription_expires_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
  };
};

// Get user by email
export const getUserByEmail = async (email: string): Promise<User | null> => {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase().trim()),
  });

  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    password_hash: user.password_hash,
    first_name: user.first_name,
    last_name: user.last_name,
    subscription_tier: user.subscription_tier,
    stripe_customer_id: user.stripe_customer_id,
    stripe_subscription_id: user.stripe_subscription_id,
    subscription_status: user.subscription_status,
    subscription_expires_at: user.subscription_expires_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
    last_login_at: user.last_login_at,
  };
};

// Update user profile
export const updateUserProfile = async (
  userId: string,
  updates: Partial<{ first_name: string; last_name: string; email: string }>
): Promise<User> => {
  const [updatedUser] = await db
    .update(users)
    .set({
      ...updates,
      updated_at: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  if (!updatedUser) {
    throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  }

  return {
    id: updatedUser.id,
    email: updatedUser.email,
    password_hash: updatedUser.password_hash,
    first_name: updatedUser.first_name,
    last_name: updatedUser.last_name,
    subscription_tier: updatedUser.subscription_tier,
    stripe_customer_id: updatedUser.stripe_customer_id,
    stripe_subscription_id: updatedUser.stripe_subscription_id,
    subscription_status: updatedUser.subscription_status,
    subscription_expires_at: updatedUser.subscription_expires_at,
    created_at: updatedUser.created_at,
    updated_at: updatedUser.updated_at,
    last_login_at: updatedUser.last_login_at,
  };
};

// Update subscription details
export const updateUserSubscription = async (
  userId: string,
  updates: {
    subscription_tier?: 'free' | 'pro' | 'dealer' | 'enterprise';
    stripe_subscription_id?: string | null;
    subscription_status?: 'active' | 'cancelled' | 'past_due' | null;
    subscription_expires_at?: Date | null;
  }
): Promise<void> => {
  await db
    .update(users)
    .set({
      ...updates,
      updated_at: new Date(),
    })
    .where(eq(users.id, userId));
};

// Request password reset (placeholder - would send email)
export const requestPasswordReset = async (email: string): Promise<void> => {
  const user = await getUserByEmail(email);
  
  if (!user) {
    // Don't reveal if email exists
    return;
  }

  // In production: generate token, save to DB, send email
  console.log(`Password reset requested for ${email}`);
};

// Reset password
export const resetPassword = async (
  userId: string,
  newPassword: string
): Promise<void> => {
  const password_hash = await hashPassword(newPassword);
  
  await db
    .update(users)
    .set({
      password_hash,
      updated_at: new Date(),
    })
    .where(eq(users.id, userId));
};
