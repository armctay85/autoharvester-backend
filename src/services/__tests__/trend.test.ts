import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regressPoints } from '../trend-math';

const DAY = 24 * 3600 * 1000;

test('regressPoints: empty input → insufficient_data', () => {
  const r = regressPoints([], 180);
  assert.equal(r.direction, 'insufficient_data');
  assert.equal(r.sampleSize, 0);
  assert.equal(r.medianPrice, null);
});

test('regressPoints: < 3 points → insufficient_data', () => {
  const now = Date.now();
  const r = regressPoints(
    [
      { t: now - 10 * DAY, p: 50_000 },
      { t: now, p: 52_000 },
    ],
    180
  );
  assert.equal(r.direction, 'insufficient_data');
  assert.equal(r.sampleSize, 2);
});

test('regressPoints: monotonically rising prices → upswing with positive velocity', () => {
  const now = Date.now();
  const points = [];
  for (let i = 0; i < 12; i++) {
    points.push({ t: now - (60 - i * 5) * DAY, p: 40_000 + i * 1000 });
  }
  const r = regressPoints(points, 180);
  assert.equal(r.direction, 'upswing');
  assert.ok((r.velocityPctPerMonth ?? 0) > 0, 'velocity should be positive');
  assert.ok(r.confidence > 0.9, `expected high R² for clean line, got ${r.confidence}`);
  assert.equal(r.sampleSize, 12);
});

test('regressPoints: monotonically falling prices → downswing', () => {
  const now = Date.now();
  const points = [];
  for (let i = 0; i < 10; i++) {
    points.push({ t: now - (50 - i * 5) * DAY, p: 60_000 - i * 800 });
  }
  const r = regressPoints(points, 180);
  assert.equal(r.direction, 'downswing');
  assert.ok((r.velocityPctPerMonth ?? 0) < 0);
});

test('regressPoints: noisy flat → flat band', () => {
  const now = Date.now();
  const points = [];
  for (let i = 0; i < 20; i++) {
    points.push({
      t: now - (100 - i * 5) * DAY,
      p: 30_000 + (i % 2 === 0 ? 50 : -50),
    });
  }
  const r = regressPoints(points, 180);
  assert.equal(r.direction, 'flat');
  assert.equal(r.sampleSize, 20);
});

test('regressPoints: respects window cutoff', () => {
  const now = Date.now();
  const points = [
    // outside window
    { t: now - 400 * DAY, p: 10_000 },
    { t: now - 350 * DAY, p: 10_000 },
    // inside window
    { t: now - 60 * DAY, p: 50_000 },
    { t: now - 30 * DAY, p: 52_000 },
    { t: now - 5 * DAY, p: 54_000 },
  ];
  const r = regressPoints(points, 180);
  assert.equal(r.sampleSize, 3, 'only 3 points should be inside the 180d window');
});

test('regressPoints: zero / negative prices are filtered', () => {
  const now = Date.now();
  const r = regressPoints(
    [
      { t: now - 60 * DAY, p: 0 },
      { t: now - 30 * DAY, p: -100 },
      { t: now - 10 * DAY, p: 50_000 },
      { t: now - 5 * DAY, p: 51_000 },
      { t: now, p: 52_000 },
    ],
    180
  );
  // 3 valid points → upswing
  assert.equal(r.sampleSize, 3);
  assert.notEqual(r.direction, 'insufficient_data');
});
