/**
 * One-shot Stripe product + price creator.
 *
 * Run with:
 *   STRIPE_SECRET_KEY=sk_live_... npm run stripe:setup
 *   STRIPE_SECRET_KEY=sk_test_... npm run stripe:setup:test
 *
 * It is idempotent: it looks for products by `metadata.autoharvester_sku` and
 * reuses any existing match instead of duplicating. Output is a block of env
 * vars you can paste into Railway / Render / your local .env.
 */

import 'dotenv/config';
import Stripe from 'stripe';

const SECRET = process.env.STRIPE_SECRET_KEY;
if (!SECRET) {
  console.error('❌ STRIPE_SECRET_KEY not set. Aborting.');
  process.exit(1);
}

const stripe = new Stripe(SECRET, { apiVersion: '2023-10-16' });
const isLive = SECRET.startsWith('sk_live_');

interface SkuSpec {
  sku: string; // metadata.autoharvester_sku
  envVar: string; // env var name to print out
  name: string;
  description: string;
  unit_amount: number; // cents
  recurring: 'month' | 'year' | null; // null = one-off
  features: string[];
}

const SKUS: SkuSpec[] = [
  // ─── One-off ──────────────────────────────────────────────────────────────
  {
    sku: 'report',
    envVar: 'STRIPE_PRICE_REPORT',
    name: 'Vehicle Intelligence Report',
    description:
      'PPSR encumbrance + write-off + stolen check, NEVDIS registration history, market value vs ask, negotiation guidance, branded PDF.',
    unit_amount: 1_900,
    recurring: null,
    features: [
      'PPSR encumbrance / write-off / stolen check',
      'NEVDIS registration history',
      'Market value range',
      'Branded PDF',
    ],
  },

  // ─── Consumer recurring ───────────────────────────────────────────────────
  {
    sku: 'watchlist_monthly',
    envVar: 'STRIPE_PRICE_WATCHLIST_MONTHLY',
    name: 'Watchlist Lite — Monthly',
    description:
      'Unlimited price-drop alerts, sold-price exact reveal on saved cars, market trend dashboard, 1 Vehicle Intelligence Report per month included.',
    unit_amount: 900,
    recurring: 'month',
    features: [
      'Unlimited alerts',
      'Sold-price reveal',
      'Trend dashboard',
      '1 report/mo included',
    ],
  },
  {
    sku: 'watchlist_yearly',
    envVar: 'STRIPE_PRICE_WATCHLIST_YEARLY',
    name: 'Watchlist Lite — Yearly',
    description: 'Same as monthly, billed yearly. 2 months free vs monthly.',
    unit_amount: 9_000,
    recurring: 'year',
    features: ['Same as monthly', 'Save $18/year'],
  },

  // ─── Dealer recurring ─────────────────────────────────────────────────────
  {
    sku: 'edge_monthly',
    envVar: 'STRIPE_PRICE_EDGE_MONTHLY',
    name: 'Dealer Edge — Monthly',
    description:
      'Real-time market dashboard, "$X over market" alerts, days-to-sell forecast, restock recommendations from auction inventory, up to 100 vehicles tracked.',
    unit_amount: 49_900,
    recurring: 'month',
    features: ['Market dashboard', 'Alerts', 'Forecasts', 'Up to 100 vehicles'],
  },
  {
    sku: 'edge_yearly',
    envVar: 'STRIPE_PRICE_EDGE_YEARLY',
    name: 'Dealer Edge — Yearly',
    description: 'Same as monthly, billed yearly. 2 months free vs monthly.',
    unit_amount: 499_000,
    recurring: 'year',
    features: ['Same as monthly', 'Save $998/year'],
  },
  {
    sku: 'inventory_iq_monthly',
    envVar: 'STRIPE_PRICE_INVENTORY_IQ_MONTHLY',
    name: 'Inventory IQ — Monthly',
    description:
      'Everything in Dealer Edge plus bulk PPSR + batch valuation, dealer-to-dealer trade matching, lead routing, up to 500 vehicles tracked.',
    unit_amount: 149_900,
    recurring: 'month',
    features: ['Bulk PPSR', 'Trade matching', 'Lead routing', 'Up to 500 vehicles'],
  },
  {
    sku: 'inventory_iq_yearly',
    envVar: 'STRIPE_PRICE_INVENTORY_IQ_YEARLY',
    name: 'Inventory IQ — Yearly',
    description: 'Same as monthly, billed yearly. 2 months free vs monthly.',
    unit_amount: 1_499_000,
    recurring: 'year',
    features: ['Same as monthly', 'Save $2,998/year'],
  },
  {
    sku: 'group_monthly',
    envVar: 'STRIPE_PRICE_GROUP_MONTHLY',
    name: 'Group — Monthly',
    description:
      'Everything in Inventory IQ plus multi-location consolidation, branded consumer microsite, full API access (50k calls/mo), dedicated AM.',
    unit_amount: 299_900,
    recurring: 'month',
    features: ['Multi-location', 'Branded microsite', 'API 50k', 'Dedicated AM'],
  },
  {
    sku: 'group_yearly',
    envVar: 'STRIPE_PRICE_GROUP_YEARLY',
    name: 'Group — Yearly',
    description: 'Same as monthly, billed yearly. 2 months free vs monthly.',
    unit_amount: 2_999_000,
    recurring: 'year',
    features: ['Same as monthly', 'Save $5,998/year'],
  },
];

async function findProductBySku(sku: string): Promise<Stripe.Product | null> {
  // Stripe doesn't index metadata directly, so list+filter (small N is fine).
  let starting_after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const list = await stripe.products.list({ limit: 100, active: true, starting_after });
    const hit = list.data.find((p) => p.metadata?.autoharvester_sku === sku);
    if (hit) return hit;
    if (!list.has_more || list.data.length === 0) break;
    starting_after = list.data[list.data.length - 1]?.id;
  }
  return null;
}

async function findOrCreatePrice(productId: string, spec: SkuSpec): Promise<Stripe.Price> {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const existing = prices.data.find((p) => {
    if (p.unit_amount !== spec.unit_amount) return false;
    if (p.currency !== 'aud') return false;
    if (spec.recurring) {
      return p.recurring?.interval === spec.recurring;
    }
    return p.recurring === null;
  });
  if (existing) return existing;

  return stripe.prices.create({
    product: productId,
    unit_amount: spec.unit_amount,
    currency: 'aud',
    ...(spec.recurring ? { recurring: { interval: spec.recurring } } : {}),
    metadata: { autoharvester_sku: spec.sku },
  });
}

async function ensureSku(spec: SkuSpec): Promise<{ envVar: string; priceId: string; productId: string; created: boolean }> {
  let product = await findProductBySku(spec.sku);
  let created = false;
  if (!product) {
    product = await stripe.products.create({
      name: spec.name,
      description: spec.description,
      metadata: { autoharvester_sku: spec.sku, source: 'autoharvester-setup-stripe' },
    });
    created = true;
  } else if (
    product.name !== spec.name ||
    (product.description ?? '') !== spec.description
  ) {
    await stripe.products.update(product.id, {
      name: spec.name,
      description: spec.description,
    });
  }

  const price = await findOrCreatePrice(product.id, spec);
  return { envVar: spec.envVar, priceId: price.id, productId: product.id, created };
}

async function main() {
  console.log(`\n🔧 AutoHarvester Stripe setup — mode: ${isLive ? 'LIVE 🟢' : 'TEST 🟡'}\n`);
  if (isLive) {
    console.log('   Using a LIVE secret key. Real products + prices will be created/updated.');
    console.log('   Set STRIPE_DRY_RUN=true to print intended actions only (TODO).\n');
  }

  const results: Array<Awaited<ReturnType<typeof ensureSku>>> = [];
  for (const spec of SKUS) {
    process.stdout.write(`   • ${spec.sku.padEnd(24)} ... `);
    try {
      const r = await ensureSku(spec);
      results.push(r);
      console.log(r.created ? `created  product=${r.productId.slice(0, 18)}…  price=${r.priceId.slice(0, 18)}…` : `reused   product=${r.productId.slice(0, 18)}…  price=${r.priceId.slice(0, 18)}…`);
    } catch (err) {
      console.error(`FAILED: ${(err as Error).message}`);
      process.exit(2);
    }
  }

  console.log('\n✅ All SKUs ensured. Paste these into Railway / Render env vars:\n');
  console.log('# ─── Copy from here ───');
  for (const r of results) {
    console.log(`${r.envVar}=${r.priceId}`);
  }
  console.log('# ─── Copy to here ───\n');

  console.log('Next steps:');
  console.log('  1. Paste the env vars above into your hosting environment.');
  console.log('  2. Add a webhook endpoint in Stripe Dashboard pointing to');
  console.log('     https://<your-backend>/api/subscription/webhook');
  console.log('     subscribed to: checkout.session.completed, payment_intent.succeeded,');
  console.log('     invoice.paid, invoice.payment_failed, customer.subscription.updated,');
  console.log('     customer.subscription.deleted');
  console.log('  3. Copy the webhook signing secret into STRIPE_WEBHOOK_SECRET.');
  console.log('  4. Redeploy the backend.\n');
}

main().catch((err) => {
  console.error('\n❌ Stripe setup failed:', err);
  process.exit(1);
});
