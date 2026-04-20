# AutoHarvester Backend — Deployment

**Stack:** Node 20 + Express + Drizzle ORM + Postgres (Neon) + Stripe.
**Hosting target:** Railway (primary) or Render. Both auto-deploy from GitHub.
**First deploy time:** ~15 minutes end-to-end. Stripe products take 5 minutes via the included `npm run stripe:setup` script.

> **Boot-without-Stripe contract.** Backend boots cleanly even with all `STRIPE_*` env vars empty. Billing endpoints return `503 STRIPE_NOT_CONFIGURED` until you populate the price IDs (step 4). This means you deploy first, then wire Stripe — never the other way around.

---

## 1. Provision Postgres (Neon)

1. Sign up: https://neon.tech
2. New Project → name `autoharvester`, region **Asia Pacific (Singapore)**
3. Copy the pooled connection string. Format:
   ```
   postgresql://<user>:<password>@<host>/autoharvester?sslmode=require
   ```
4. Save it as `DATABASE_URL` (you'll paste it into Railway in step 3).

---

## 2. Generate security secrets

Run locally (Git Bash on Windows works fine; PowerShell needs `[System.Convert]::ToBase64String((1..32 | ForEach-Object {Get-Random -Min 0 -Max 256}))`):

```bash
openssl rand -base64 32   # → JWT_SECRET
openssl rand -base64 32   # → SESSION_SECRET
```

Save both — you'll paste them into Railway next.

---

## 3. Deploy backend to Railway

1. Push this repo to GitHub (see step 8 below if not already done).
2. https://railway.app → **New Project → Deploy from GitHub repo** → pick `autoharvester-backend`.
3. Railway auto-detects Node + uses `railway.json` for build/start.
4. **Variables** tab → paste:
   ```
   DATABASE_URL=<your Neon URL>
   JWT_SECRET=<from step 2>
   SESSION_SECRET=<from step 2>
   FRONTEND_URL=https://autoharvester.com.au
   NODE_ENV=production
   PORT=3001

   # Email provider — 'log' is fine for launch; swap for resend once signed up.
   EMAIL_PROVIDER=log
   # EMAIL_PROVIDER=resend
   # RESEND_API_KEY=re_...
   EMAIL_FROM=Autoharvester <hello@autoharvester.com.au>
   ```
5. Wait for first deploy. `/health` should return 200.
6. **Settings → Networking → Generate domain.** Copy the URL (e.g. `https://autoharvester-backend.up.railway.app`).

> **Render alternative:** New Web Service → Connect repo → Build `npm install && npm run build` → Start `npm run start` → same env vars.

---

## 4. Run Stripe products one-shot

The `setup-stripe.ts` script is **idempotent** — it looks up products by `metadata.autoharvester_sku` and reuses any existing match. Safe to re-run.

### Test mode (recommended first)

Run locally with your Stripe **test** secret key:

```bash
cd autoharvester-backend
echo "STRIPE_SECRET_KEY=sk_test_..." > .env
npm install
npm run stripe:setup:test
```

Output ends with a copy-paste block of env vars:

```
STRIPE_PRICE_REPORT=price_1Q...
STRIPE_PRICE_WATCHLIST_MONTHLY=price_1Q...
STRIPE_PRICE_WATCHLIST_YEARLY=price_1Q...
STRIPE_PRICE_EDGE_MONTHLY=price_1Q...
STRIPE_PRICE_EDGE_YEARLY=price_1Q...
STRIPE_PRICE_INVENTORY_IQ_MONTHLY=price_1Q...
STRIPE_PRICE_INVENTORY_IQ_YEARLY=price_1Q...
STRIPE_PRICE_GROUP_MONTHLY=price_1Q...
STRIPE_PRICE_GROUP_YEARLY=price_1Q...
```

### Live mode (when ready to take real money)

Same command with the live key:

```bash
STRIPE_SECRET_KEY=sk_live_... npm run stripe:setup
```

### Paste price IDs into Railway

Add the 9 `STRIPE_PRICE_*` vars + `STRIPE_SECRET_KEY` to the Railway environment.

---

## 5. Configure Stripe webhook

1. https://dashboard.stripe.com/webhooks → **Add endpoint**
2. URL: `https://<your-railway-url>/api/subscription/webhook`
3. Select events:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the signing secret (`whsec_...`) into Railway as `STRIPE_WEBHOOK_SECRET`.
5. Railway redeploys. Hit `/api/subscription/plans` to verify `billing.fully_wired=true`.

---

## 6. Database schema sync

The included `Procfile` runs `drizzle-kit push:pg` on every deploy's **release** phase, so the schema (and any new columns, like the `customer_email` + `email_sent_at` added on the `reports` table for report-ready delivery) is applied automatically on first deploy.

```
release: npx drizzle-kit push:pg --config=./drizzle.config.ts
```

If your platform doesn't honour Procfile release phases (rare — Railway and Render both do), run this once manually from your machine:

```bash
DATABASE_URL=<neon url> npm run db:push
```

> `push:pg` is the greenfield-friendly path — it reconciles the schema directly. Once you have production data you care about, switch to the migration workflow (`npm run db:generate` → commit → `npm run db:migrate`).

---

## 7. Wire frontend (autoharvester on Vercel)

In the `autoharvester` (frontend) Vercel project, add:

```
NEXT_PUBLIC_API_BASE=https://<your-railway-url>
```

> Note: the frontend reads `NEXT_PUBLIC_API_BASE` (not `_API_URL`). See `autoharvester/.env.example`.

Then redeploy the frontend. The pricing page CTAs and the Vehicle Intelligence Report form will hit the backend. Until this env var is set, the report button renders a disabled "Reports go live as soon as the backend is wired" state — no broken redirects.

---

## 8. First-time GitHub push (if repo isn't on GitHub yet)

```bash
cd autoharvester-backend
git init -b main
git add -A
git commit -m "feat: initial AutoHarvester backend"
gh repo create armctay85/autoharvester-backend --private --source=. --push
```

---

## Smoke-test checklist

After step 5 redeploy:

```bash
# Health
curl https://<railway-url>/health
# → {"status":"ok",...}

# API info
curl https://<railway-url>/api
# → {"name":"AutoHarvester API",...}

# Plans (should list 8 plans + billing.fully_wired=true)
curl https://<railway-url>/api/subscription/plans

# Report checkout (should return Stripe URL)
curl -X POST https://<railway-url>/api/subscription/checkout/report \
  -H "Content-Type: application/json" \
  -d '{"vin":"WVWZZZ1JZ3W386752"}'
# → {"sessionId":"cs_...","url":"https://checkout.stripe.com/...","reportId":"..."}
```

## End-to-end smoke test (pay a test $0.50)

In Stripe **test** mode (not live), open the checkout URL you got above in a browser, pay with `4242 4242 4242 4242 / any future date / any CVC / any postcode`. Verify:

1. Webhook hits `/api/subscription/webhook` (Stripe dashboard → Webhooks → shows 200).
2. Railway logs show `[stripe webhook] checkout.session.completed` and `[reports] runReport` completing.
3. `GET /api/reports/:reportId` returns `status: 'ready'`.
4. Log line `[email/log] to=<your email> subject="Your Vehicle Intelligence Report..."` — that proves report-email rendering worked without needing a Resend key.
5. On the Stripe success redirect, `https://<frontend>/report/ready?report_id=...&session_id=...` renders the confirmation page.

Only after all five pass should you flip `EMAIL_PROVIDER=resend` and `STRIPE_SECRET_KEY=sk_live_...` for real traffic.

---

## Cost breakdown

| Service | Tier | Monthly cost |
|---|---|---|
| Neon Postgres | Free (500MB) | **$0** |
| Neon Postgres | Pro (10GB) | $19 |
| Railway | Hobby (developer) | $5 |
| Railway | Pro | $20 |
| Stripe | Pay-as-you-go | 1.75% + 30¢/AU domestic |
| Resend (email digest) | Free (3k emails/mo) | $0 |

**Recommended starting posture:** Neon Free + Railway Hobby + Stripe + Resend Free = **$5/mo all-in** until you have paying customers.

---

## Troubleshooting

**Boot logs say `STRIPE_NOT_CONFIGURED` 503s on `/api/subscription/*`.**
Expected before step 4. Backend is healthy; just billing isn't wired yet.

**`npm run stripe:setup` errors with `Stripe authentication failed`.**
Your `STRIPE_SECRET_KEY` is wrong. Check it starts with `sk_test_` (test mode) or `sk_live_` (live mode).

**Webhook 400s with `invalid signature`.**
Either the wrong `STRIPE_WEBHOOK_SECRET` is set, or your Express `express.json()` is consuming the raw body before the webhook route. The included `src/index.ts` already mounts `express.raw({ type: 'application/json' })` on `/api/subscription/webhook` BEFORE `express.json()`, so this should work out of the box.

**`drizzle-kit migrate` fails with SSL error.**
Neon requires SSL — make sure your `DATABASE_URL` ends with `?sslmode=require`.
