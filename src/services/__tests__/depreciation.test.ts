import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDepreciation, totalCostOfOwnership } from '../depreciation-math';

test('projectDepreciation: mainstream petrol drops ~18% in year 1', () => {
  const r = projectDepreciation({
    purchasePrice: 40_000,
    segment: 'mainstream_petrol',
    years: 5,
  });
  assert.equal(r.schedule.length, 5);
  // Year 1 cliff ≈ 18%
  assert.ok(r.schedule[0]!.cumulativeLossPct >= 17 && r.schedule[0]!.cumulativeLossPct <= 19);
  // Residual after 5y should be roughly 50% for this curve
  assert.ok(r.fiveYearResidualPct < 60 && r.fiveYearResidualPct > 40,
    `expected 5yr residual 40-60%, got ${r.fiveYearResidualPct}`);
});

test('projectDepreciation: utes/4WDs hold value better than EV premium', () => {
  const ute = projectDepreciation({ purchasePrice: 60_000, segment: 'ute_4wd', years: 5 });
  const ev  = projectDepreciation({ purchasePrice: 60_000, segment: 'ev_premium', years: 5 });
  assert.ok(ute.fiveYearResidualPct > ev.fiveYearResidualPct,
    'ute should retain more value than EV premium');
});

test('projectDepreciation: classic_appreciating actually appreciates over 5y', () => {
  const r = projectDepreciation({
    purchasePrice: 100_000,
    segment: 'classic_appreciating',
    years: 5,
  });
  assert.ok(r.fiveYearResidualPct >= 100,
    `classic should be >= 100% after 5y, got ${r.fiveYearResidualPct}`);
});

test('totalCostOfOwnership: produces sane per-km cost for mainstream petrol', () => {
  const r = totalCostOfOwnership({
    purchasePrice: 40_000,
    segment: 'mainstream_petrol',
    years: 5,
  });
  assert.equal(r.yearly.length, 5);
  // AU 5yr TCO for a $40k car typically lands $0.50–$1.00/km (depreciation
  // dominates). We sanity-check the band rather than the exact number.
  assert.ok(r.totals.perKmAud >= 0.4 && r.totals.perKmAud <= 1.5,
    `per-km AUD expected 0.4–1.5, got ${r.totals.perKmAud}`);
});

test('totalCostOfOwnership: EV has zero fuel cost', () => {
  const r = totalCostOfOwnership({
    purchasePrice: 60_000,
    segment: 'ev_mainstream',
    years: 5,
  });
  for (const y of r.yearly) {
    assert.equal(y.fuel, 0, 'EV fuel cost should be 0');
  }
});

test('totalCostOfOwnership: overrides win over segment defaults', () => {
  const r = totalCostOfOwnership({
    purchasePrice: 40_000,
    segment: 'mainstream_petrol',
    annualKilometres: 10_000,
    fuelPricePerLitre: 2.50,
    insurancePerYear: 2000,
    regoPerYear: 1000,
    servicingPerYear: 1500,
  });
  assert.equal(r.yearly[0]!.insurance, 2000);
  assert.equal(r.yearly[0]!.rego, 1000);
  assert.equal(r.yearly[0]!.servicing, 1500);
});
