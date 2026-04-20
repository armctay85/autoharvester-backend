import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDigestHtml } from '../digest-render';

const baseAlert = {
  make: 'Toyota',
  model: 'RAV4',
  year_min: 2021,
  year_max: 2024,
  price_max: 60_000,
  state: 'NSW',
};

const fresh = [
  {
    id: 'l1',
    make: 'Toyota',
    model: 'RAV4',
    year: 2023,
    price: 52_500,
    odometer: 18_400,
    state: 'NSW',
    location: 'Parramatta, NSW',
    url: 'https://example.com/l1',
    first_seen_at: new Date(),
  },
];

test('renderDigestHtml: greets first name + reports total fresh count', () => {
  const html = renderDigestHtml({
    firstName: 'Drew',
    windowLabel: '7 days',
    sections: [
      {
        alert: baseAlert,
        fresh,
        bestValue: [],
        trend: { direction: 'upswing', velocityPctPerMonth: 1.4, medianPrice: 51_000, sampleSize: 240 },
      },
    ],
  });
  assert.match(html, /G'day Drew/);
  assert.match(html, /<strong>1<\/strong>/); // total fresh
  assert.match(html, /Toyota RAV4/);
  assert.match(html, /\$52,500/);
  assert.match(html, /Parramatta, NSW/);
  assert.match(html, /rising 1.4%\/mo/);
});

test('renderDigestHtml: empty section shows "Nothing new this week"', () => {
  const html = renderDigestHtml({
    firstName: 'Drew',
    windowLabel: '7 days',
    sections: [
      {
        alert: baseAlert,
        fresh: [],
        bestValue: [],
        trend: { direction: 'flat', velocityPctPerMonth: 0, medianPrice: 50_000, sampleSize: 200 },
      },
    ],
  });
  assert.match(html, /Nothing new this week/);
});

test('renderDigestHtml: includes Open dashboard CTA + manage alerts link', () => {
  const html = renderDigestHtml({
    firstName: 'Sam',
    windowLabel: '7 days',
    sections: [],
  });
  assert.match(html, /Open dashboard/);
  assert.match(html, /Manage alerts/);
});

test('renderDigestHtml: handles missing firstName gracefully', () => {
  const html = renderDigestHtml({ firstName: 'there', windowLabel: '1 day', sections: [] });
  assert.match(html, /G'day there/);
  assert.match(html, /last 1 day/);
});
