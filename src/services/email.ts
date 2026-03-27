import { env } from '../config/env';

// Email service - placeholder implementation
// In production, integrate with SendGrid, AWS SES, or similar

interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

// Send email
export const sendEmail = async (options: EmailOptions): Promise<void> => {
  // In production, this would call your email provider's API
  console.log('📧 Email would be sent:', {
    to: options.to,
    subject: options.subject,
    environment: env.NODE_ENV,
  });

  // Example integration (commented out):
  // await sendgrid.send({
  //   to: options.to,
  //   from: 'noreply@autoharvester.com.au',
  //   subject: options.subject,
  //   text: options.text,
  //   html: options.html,
  // });
};

// Send password reset email
export const sendPasswordResetEmail = async (
  email: string,
  resetToken: string
): Promise<void> => {
  const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${resetToken}`;

  await sendEmail({
    to: email,
    subject: 'Reset your AutoHarvester password',
    text: `Click the link to reset your password: ${resetUrl}`,
    html: `
      <h1>Password Reset</h1>
      <p>You requested a password reset for your AutoHarvester account.</p>
      <p>Click the link below to reset your password:</p>
      <a href="${resetUrl}">Reset Password</a>
      <p>If you didn't request this, please ignore this email.</p>
    `,
  });
};

// Send welcome email
export const sendWelcomeEmail = async (
  email: string,
  firstName: string
): Promise<void> => {
  await sendEmail({
    to: email,
    subject: 'Welcome to AutoHarvester!',
    text: `Hi ${firstName}, welcome to AutoHarvester! Start exploring sold car prices today.`,
    html: `
      <h1>Welcome to AutoHarvester! 🚗</h1>
      <p>Hi ${firstName},</p>
      <p>Thanks for joining AutoHarvester! You're now part of the community that knows what cars actually sell for.</p>
      <p>Start exploring:</p>
      <ul>
        <li>Search sold car prices</li>
        <li>Set price alerts</li>
        <li>Track market trends</li>
      </ul>
      <p><a href="${env.FRONTEND_URL}/search">Start Searching</a></p>
    `,
  });
};

// Send price alert email
export const sendPriceAlertEmail = async (
  email: string,
  listingDetails: {
    make: string;
    model: string;
    year: number;
    price: number;
    url: string;
  }
): Promise<void> => {
  const { make, model, year, price, url } = listingDetails;

  await sendEmail({
    to: email,
    subject: `Price Alert: ${year} ${make} ${model}`,
    text: `A car matching your criteria is now available for $${price.toLocaleString()}. View it here: ${url}`,
    html: `
      <h1>Price Alert 🚨</h1>
      <p>A car matching your criteria is now available!</p>
      <div style="border: 1px solid #ddd; padding: 15px; margin: 15px 0;">
        <h2>${year} ${make} ${model}</h2>
        <p style="font-size: 24px; color: #22c55e; font-weight: bold;">
          $${price.toLocaleString()}
        </p>
        <a href="${url}" style="display: inline-block; padding: 10px 20px; background: #3b82f6; color: white; text-decoration: none; border-radius: 5px;">
          View Listing
        </a>
      </div>
    `,
  });
};
