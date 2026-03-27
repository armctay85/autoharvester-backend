# AutoHarvester Backend

A production-ready Node.js/TypeScript API for the AutoHarvester car market intelligence platform.

## Features

- 🔐 **Session-based authentication** with Passport.js
- 💳 **Stripe subscription management** with webhook handling
- 🚗 **Car listing search** with filtering and pagination
- 📊 **Price history tracking** - our core value proposition
- 🔔 **Price alerts** and saved searches
- 🛡️ **Security-first** with Helmet, rate limiting, and bcrypt
- 🗄️ **PostgreSQL** with Drizzle ORM

## Tech Stack

- **Runtime:** Node.js 20 + TypeScript
- **Framework:** Express.js
- **Database:** PostgreSQL (Neon recommended)
- **ORM:** Drizzle ORM
- **Auth:** Passport.js (session-based)
- **Payments:** Stripe
- **Validation:** Zod

## Quick Start

### 1. Install Dependencies

```bash
cd autoharvester-backend
npm install
```

### 2. Configure Environment

```bash
cp .env.template .env
# Edit .env with your values
```

### 3. Database Setup

Create a PostgreSQL database (Neon recommended for serverless):

```bash
# Generate migrations
npm run db:generate

# Apply migrations
npm run db:migrate
```

### 4. Stripe Setup

1. Create a Stripe account at https://stripe.com
2. Create products and prices in the Dashboard:
   - Pro Monthly: $29/month
   - Pro Yearly: $290/year
   - Dealer Monthly: $299/month
   - Dealer Yearly: $2,990/year
3. Copy the price IDs to your `.env`
4. Set up webhook endpoint pointing to `/api/subscription/webhook`

### 5. Run Locally

```bash
# Development mode with hot reload
npm run dev

# Production build
npm run build
npm start
```

## API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create new account |
| POST | `/api/auth/login` | Login with email/password |
| POST | `/api/auth/logout` | Logout current user |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/forgot-password` | Request password reset |
| POST | `/api/auth/reset-password` | Reset password with token |

### Listings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/listings/search` | Search listings with filters |
| GET | `/api/listings/:id` | Get single listing details |
| GET | `/api/listings/makes` | List all car makes |
| GET | `/api/listings/models` | List models for a make |

### User (Authenticated)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/user/profile` | Get user profile |
| PATCH | `/api/user/profile` | Update profile |
| GET | `/api/user/saved-searches` | List saved searches |
| POST | `/api/user/saved-searches` | Save a search |
| DELETE | `/api/user/saved-searches/:id` | Delete saved search |
| GET | `/api/user/price-alerts` | List price alerts |
| POST | `/api/user/price-alerts` | Create price alert |
| DELETE | `/api/user/price-alerts/:id` | Delete price alert |

### Subscriptions
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/subscription/plans` | List available plans |
| POST | `/api/subscription/checkout` | Create checkout session |
| GET | `/api/subscription/portal` | Billing portal |
| GET | `/api/subscription/status` | Get subscription status |
| POST | `/api/subscription/webhook` | Stripe webhooks |

### Admin (Dealer/Enterprise)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/users` | List all users |
| GET | `/api/admin/stats` | Dashboard stats |
| POST | `/api/admin/listings` | Manual listing entry |
| DELETE | `/api/admin/listings/:id` | Delete listing |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | ✅ |
| `STRIPE_SECRET_KEY` | Stripe secret key | ✅ |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | ✅ |
| `STRIPE_PRICE_*` | Stripe price IDs for each plan | ✅ |
| `JWT_SECRET` | Secret for JWT signing | ✅ |
| `SESSION_SECRET` | Secret for session encryption | ✅ |
| `FRONTEND_URL` | Frontend application URL | ✅ |
| `PORT` | Server port (default: 3001) | ❌ |
| `NODE_ENV` | Environment (development/production) | ❌ |

## Subscription Tiers

| Tier | Price | Searches | Alerts | Features |
|------|-------|----------|--------|----------|
| Free | $0 | 5 | 1 | Basic search only |
| Pro | $29/mo | 50 | 10 | Sold prices, export |
| Dealer | $299/mo | 500 | 100 | Admin access, bulk import |
| Enterprise | Custom | Unlimited | Unlimited | API access |

## Database Schema

### Users
- Authentication and profile data
- Subscription management
- Stripe customer linking

### Car Listings
- Core vehicle data
- Price history (JSON array)
- Sold price tracking
- Source attribution

### Price Alerts
- User-defined criteria
- Email notification triggers

### Saved Searches
- Named search parameters
- Quick re-search functionality

## Security

- ✅ bcrypt (12 rounds) for password hashing
- ✅ Helmet for security headers
- ✅ Rate limiting: 100 req/min API, 5 req/min auth
- ✅ Zod input validation
- ✅ CORS configured
- ✅ Session-based auth with httpOnly cookies

## Deployment

### Railway/Render/Heroku

1. Set environment variables in dashboard
2. Connect GitHub repository
3. Deploy automatically on push

### Docker (optional)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

### Environment Checklist for Production

- [ ] Set `NODE_ENV=production`
- [ ] Use strong secrets for JWT and SESSION
- [ ] Configure Stripe webhook URL
- [ ] Set up database (Neon/RDS/Supabase)
- [ ] Configure CORS for production domain
- [ ] Set up monitoring/logging

## Development

```bash
# Run in watch mode
npm run dev

# Generate migration
npm run db:generate

# Apply migration
npm run db:migrate

# Open Drizzle Studio
npm run db:studio

# Type check
npm run typecheck

# Lint
npm run lint
```

## Testing Stripe Webhooks Locally

Use Stripe CLI:

```bash
stripe login
stripe listen --forward-to localhost:3001/api/subscription/webhook
```

## License

MIT
