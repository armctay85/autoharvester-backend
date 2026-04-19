# Insights API

Mounted at `/api/insights`. Powers the consumer "ownership intelligence"
features (Watchlist tier) and the dealer pricing feedback (Dealer Edge /
Inventory IQ tiers).

All endpoints accept anonymous traffic for the marketing site to render
real data; tier-gated narrative output (`narrate=true`) is layered on top
once auth is wired into the dashboard.

## Endpoints

### `GET /api/insights/catalogue/classics`
Curated AU-relevant classic-car catalogue (R32–R34 GT-Rs, GTHO Phase III,
964/993 911s, E30/E36/CSL M3, 360 Modena, etc.). Used as the seed for the
"Find a Classic" engine.

### `GET /api/insights/catalogue/classics/:slug`
Single classic + its current observed trend.

### `GET /api/insights/trend`
Query params:
- `canonicalId` — vehicle_canonical UUID, **or**
- `make` + `model` (+ optional `year`)
- `windowDays` (default 180, max 1825)
- `narrate=true` — request optional AI summary

Returns OLS regression over every observed price point (live listing
prices, sold prices, and `price_history` JSONB entries). Surfaces:

| field | meaning |
|---|---|
| `direction` | `upswing` \| `downswing` \| `flat` \| `insufficient_data` |
| `velocityPctPerMonth` | slope normalised against the regression intercept |
| `confidence` | R² of the fit (0..1) |
| `medianPrice`, `minPrice`, `maxPrice` | sample stats |
| `sampleSize` | points in window |

### `POST /api/insights/find/classics`
Body:
```json
{
  "budget": 80000,
  "budgetMax": 150000,
  "era": "1990s",
  "purpose": "investment",
  "risk": "balanced",
  "narrate": false
}
```
Ranks every catalogue entry on `velocity + sample confidence − risk + purpose fit`.

### `POST /api/insights/find/daily`
Body:
```json
{
  "budgetMax": 50000,
  "budgetMin": 30000,
  "yearMin": 2018,
  "bodyType": "ute",
  "fuelType": "diesel",
  "segment": "ute_4wd",
  "state": "NSW",
  "maxKilometres": 80000,
  "narrate": false
}
```
Searches live `car_listings`, scores by value-vs-market + trend +
5yr depreciation residual, returns top candidates.

### `POST /api/insights/depreciation`
Body:
```json
{
  "make": "Toyota",
  "model": "Hilux",
  "year": 2022,
  "segment": "ute_4wd",
  "purchasePrice": 60000,
  "years": 5
}
```
Returns:
- empirical median price + trend (DB-derived)
- heuristic curve (segment-calibrated)
- sanity-check delta between empirical and heuristic annual %

### `POST /api/insights/tco`
Body:
```json
{
  "purchasePrice": 60000,
  "segment": "ute_4wd",
  "annualKilometres": 18000,
  "years": 5,
  "fuelPricePerLitre": 2.05
}
```
Returns yearly cost breakdown and per-km AUD.

### `GET /api/insights/dealer/:dealerId/alerts`
Query: `narrate=true` for AI summary.

For every active feed listing pinned to `:dealerId`, computes pricing
delta vs market median and bands as:

| band | trigger | typical recommendation |
|---|---|---|
| `over_market_steep` | Δ > +8 % | drop 5–8 % to avoid DOM blowout |
| `over_market_mild` | +3..+8 % | match median for sale velocity |
| `on_market` | ±3 % | hold |
| `under_market_mild` | −3..−8 % | review for missed equipment |
| `under_market_steep` | < −8 % | sanity-check listing |

Cron entrypoint: `services/dealer-alerts.ts → sweepAllActiveDealers()`.

## Architecture

```
src/services/
  trend-math.ts          ← pure regression (unit-tested, no env/DB)
  trend.ts               ← DB-aware wrapper around trend-math
  depreciation-math.ts   ← pure curves + TCO (unit-tested)
  depreciation.ts        ← DB-aware wrapper, sanity-checks vs trend
  find.ts                ← classic catalogue + scoring engines
  dealer-alerts.ts       ← per-dealer pricing alerts
  ai-narrative.ts        ← optional GPT-5 narrative (graceful no-key fallback)
src/routes/insights.ts   ← Express wiring, Zod validated
src/services/__tests__/  ← 13 trend + depreciation tests (node:test)
```

## Pattern transfer log

Ported from `CarSavingsTracker` prototype:
- OLS regression on observed prices (`carTrackerStore.computeTrend` →
  `trend-math.ts`)
- "Find a classic" scoring with risk + purpose biases
  (`classicTrackerStore.findClassics` → `find.ts`)
- AU-relevant classic catalogue (`classicCatalogue.js` → embedded in
  `find.ts`)
- Optional AI narrative with graceful fallback (`classicAi.js` →
  `ai-narrative.ts`, upgraded to GPT-5 reasoning_effort=minimal pattern
  to avoid the EstiMate-style empty-completion trap)

New for v2:
- Heuristic depreciation curves per segment (10 calibrations)
- Per-km TCO with AU-default fuel/insurance/rego
- Dealer "you are $X over market" engine with trend-tilted recommendations
- `vehicle_canonical_id` aware grouping for cross-source deduping
