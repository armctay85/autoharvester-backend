import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockNevdisProvider } from '../nevdis';

const provider = new MockNevdisProvider();

test('MockNevdisProvider: deterministic for identical input', async () => {
  const a = await provider.check({ vin: 'JTNBL40K803012345' });
  const b = await provider.check({ vin: 'JTNBL40K803012345' });
  assert.equal(a.certificate_id, b.certificate_id);
  assert.equal(a.state_transfer_count, b.state_transfer_count);
  assert.equal(a.odometer_inconsistency, b.odometer_inconsistency);
  assert.equal(a.written_off.is_write_off, b.written_off.is_write_off);
});

test('MockNevdisProvider: returns full payload shape', async () => {
  const r = await provider.check({ vin: 'TEST00000000VINXY', state: 'NSW' });
  assert.equal(r.provider, 'mock');
  assert.ok(Array.isArray(r.registrations));
  assert.ok(Array.isArray(r.odometer_history));
  assert.ok(r.odometer_history.length > 0);
  assert.match(r.certificate_id, /^NEVDIS-MOCK-/);
  assert.equal(typeof r.state_transfer_count, 'number');
  assert.equal(typeof r.odometer_inconsistency, 'boolean');
});

test('MockNevdisProvider: different VINs return different certificates', async () => {
  const a = await provider.check({ vin: 'AAAAAAAAAAAAAAAAA' });
  const b = await provider.check({ vin: 'BBBBBBBBBBBBBBBBB' });
  assert.notEqual(a.certificate_id, b.certificate_id);
});

test('MockNevdisProvider: odometer history is monotone unless inconsistency flag set', async () => {
  // Sweep a bunch of seeds; whenever odometer_inconsistency=false we expect
  // monotonically non-decreasing readings.
  for (let i = 0; i < 200; i++) {
    const r = await provider.check({ vin: `SEED${i.toString().padStart(13, '0')}` });
    if (!r.odometer_inconsistency) {
      for (let j = 1; j < r.odometer_history.length; j++) {
        assert.ok(
          r.odometer_history[j]!.reading_km >= r.odometer_history[j - 1]!.reading_km,
          `seed ${i}: monotone violation at index ${j}`
        );
      }
    }
  }
});
