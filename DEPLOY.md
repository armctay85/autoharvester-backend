# AutoHarvester Deployment Config

## 1. Neon PostgreSQL Setup

**URL:** https://neon.tech

**Steps:**
1. Sign up / Log in
2. Create new project: "autoharvester"
3. Region: "Asia Pacific (Singapore)" (closest to Australia)
4. Copy connection string:
```
postgresql://[user]:[password]@[host]/autoharvester?sslmode=require
```

## 2. Environment Variables

Create `.env` file in autoharvester-backend:

```bash
# Database
DATABASE_URL=postgresql://[user]:[password]@[host]/autoharvester?sslmode=require

# Security (generate new secrets)
JWT_SECRET=$(openssl rand -base64 32)
SESSION_SECRET=$(openssl rand -base64 32)

# Stripe (create account at stripe.com)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_DEALER_MONTHLY=price_...
STRIPE_PRICE_DEALER_YEARLY=price_...

# App
FRONTEND_URL=https://autoharvester.com.au
PORT=3001
NODE_ENV=production
```

## 3. Railway Deployment

**URL:** https://railway.app

**Steps:**
1. New Project → Deploy from GitHub repo
2. Select: `armctay85/autoharvester-backend`
3. Add environment variables (from above)
4. Deploy

**Alternative: Render**
**URL:** https://render.com
- New Web Service
- Connect GitHub repo
- Build: `npm install && npm run build`
- Start: `npm start`

## 4. Database Migration

After deployment:
```bash
# Run migrations
npm run db:migrate

# Or use Drizzle Kit directly
npx drizzle-kit migrate
```

## 5. Stripe Webhook Setup

1. Stripe Dashboard → Developers → Webhooks
2. Add endpoint: `https://[your-railway-url]/api/subscription/webhook`
3. Select events:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `customer.subscription.deleted`
4. Copy signing secret to `STRIPE_WEBHOOK_SECRET`

## 6. Frontend Connection

Update autoharvester-website to point to backend:

```typescript
// src/lib/api.ts
const API_URL = process.env.NEXT_PUBLIC_API_URL || 
  'https://autoharvester-backend.up.railway.app';
```

## Cost Breakdown

| Service | Tier | Cost |
|---------|------|------|
| Neon PostgreSQL | Free (500MB) | $0/mo |
| Neon PostgreSQL | Pro (10GB) | $19/mo |
| Railway | Starter | $5/mo |
| Railway | Pro | $20/mo |
| Stripe | Pay-as-you-go | 2.9% + 30¢/transaction |

**Recommended:** Start with free tiers, upgrade when you have paying customers.
