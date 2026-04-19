# User‑contribution capture (`/api/capture`)

> Pattern lifted from the standalone **CarSavingsTracker** prototype
> (`Cursor/CarSavingsTracker/`) and folded into the v2 ingestion plan.
> Sister doc to `AUDIT_AND_UPLIFT.md` §4.1 (legitimate AU sources, "user
> contribution" row).

## What it gives us

A legal, low‑cost data flywheel that:

1. Lets a logged‑in user (or a friendly tester) browse Carsales / Gumtree /
   Facebook Marketplace **with their own session**, and
2. Lets a small browser extension POST that page's listing payload to our API
   under a short‑lived bearer token, so we
3. Append it to `vehicle_canonical` + `car_listings` + `data_provenance` —
   building real depreciation curves from repeat captures over time.

It is the cheapest way to seed real listings before partner feeds (Pickles,
Manheim) are signed, and it stays well clear of the §2.3 scraping landmines
because the capture is happening client‑side under the user's own session.

## Endpoints

| Method | Path                       | Purpose                                             |
| ------ | -------------------------- | --------------------------------------------------- |
| POST   | `/api/capture/token`       | Mint a 7‑day bearer token (per‑user attribution)    |
| POST   | `/api/capture`             | Ingest a listing payload from the browser extension |

### Mint a token

```bash
curl -sS -X POST http://localhost:3001/api/capture/token \
  -H 'Content-Type: application/json' \
  -d '{"source":"carsales"}'
```

Response:

```json
{
  "token": "…base64url…",
  "expires_at": "2026-04-26T03:14:15.000Z",
  "attributed_user_id": null,
  "source_hint": "carsales"
}
```

If the request is authenticated (session cookie or future API key),
`attributed_user_id` is populated and the user gets credit for every capture
made under that token.

### Ingest a listing

```bash
curl -sS -X POST http://localhost:3001/api/capture \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{
        "external_id": "carsales:2021-rav4-hybrid-cruiser-sydney-12345",
        "listing_url": "https://www.carsales.com.au/cars/details/12345",
        "make": "Toyota",
        "model": "RAV4",
        "year": 2021,
        "variant": "Cruiser Hybrid",
        "price": 47990,
        "odometer": 38500,
        "transmission": "Automatic",
        "fuel_type": "Hybrid",
        "body_type": "SUV",
        "colour": "Atomic Rush",
        "location": "Sydney NSW",
        "state": "NSW",
        "images": ["https://…/photo1.jpg"]
      }'
```

Response:

```json
{
  "ok": true,
  "listing_id": "<uuid>",
  "vehicle_canonical_id": "<uuid>",
  "price_delta": -1000,
  "captured_at": "2026-04-19T03:14:15.000Z"
}
```

`price_delta` is non‑null on subsequent captures of the same `external_id`
when the price has changed. Each capture appends to `price_history` so the
depreciation curve emerges naturally.

## Schema impact

- **`vehicle_canonical`** — every capture funnels through `upsertCanonical()`
  in `src/services/canonical.ts`, so the same physical car is one row even if
  it bounces between sources.
- **`car_listings`** — keyed on `(source, external_id)`. `source` is forced to
  `'user_contribution'` for this lane.
- **`data_provenance`** — every capture writes a row including
  `source_partner` (the page domain hint) and `notes` with the attributed
  user id.

## Browser extension

The reference Chrome MV3 extension lives in `Cursor/CarSavingsTracker/extension/`
and currently targets `carsales.com.au`. To wire it to this backend instead of
the standalone tracker, point its `apiBase` setting at this server and use
`/api/capture/token` + `/api/capture` instead of the tracker's
`/api/car-tracker/*` paths. (The payload schema is intentionally compatible
with the new backend route — the field names align.)

## Pattern transfer log

| CarSavingsTracker piece                         | Autoharvester equivalent / status                     |
| ----------------------------------------------- | ----------------------------------------------------- |
| `server/carTrackerStore.js` (flat JSON store)   | replaced by Drizzle + Postgres (`car_listings` table) |
| `generateCaptureToken / isTokenValid`           | `mintToken / validateToken` in `routes/capture.ts`    |
| `createListing` + `createSnapshot`              | `upsertCanonical` + capture upsert                    |
| `calcPriceDelta`                                | inline price‑delta in `routes/capture.ts`             |
| `estimateDepreciation`                          | TODO — wire into `Vehicle Intelligence Report`        |
| `estimateOwnershipCost`                         | TODO — surface in `/concierge` brief                  |
| `classicTrackerStore.computeTrend` (regression) | TODO — `services/trend.ts` for Dealer Edge alerts     |
| `classicTrackerStore.findClassics`              | TODO — power `/find-a-classic` SEO landing pages      |
| `classicAi.narrateTrend`                        | TODO — narrative paragraph in Vehicle Report PDF      |

The TODOs above are tracked in `AUDIT_AND_UPLIFT.md` §5 (90‑day roadmap).
