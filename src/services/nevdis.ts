// ─────────────────────────────────────────────────────────────────────────────
//  NEVDIS adapter (scaffold)
//
//  NEVDIS = National Exchange of Vehicle and Driver Information System.
//  Operated by Austroads. Provides nationally-consolidated registration,
//  written-off vehicle, and stolen-vehicle data sourced from each state &
//  territory's transport authority.
//
//  Access is through approved data resellers (PPSR-style):
//    • CarHistory.com.au       — consumer-facing reseller, easiest entry
//    • Equifax / Veda          — enterprise
//    • InfoTrack / GlobalX     — same auth path as PPSR (often bundled)
//
//  This file ships a typed adapter interface and a deterministic
//  `MockNevdisProvider` so the Vehicle Intelligence Report flow runs end-to-
//  end without credentials. Swap for `CarHistoryNevdisProvider` (or
//  `InfoTrackNevdisProvider`) once a reseller account is signed.
//
//  Configure via env: NEVDIS_PROVIDER=carhistory|infotrack|mock
//
//  See AUDIT_AND_UPLIFT.md §4.1 + §3.2 surface 1.
// ─────────────────────────────────────────────────────────────────────────────

export interface NevdisCheckRequest {
  vin?: string;
  rego?: string;
  state?: string;
}

export interface NevdisRegistrationRecord {
  state: string;
  status: 'current' | 'expired' | 'cancelled' | 'suspended';
  effective_from: string;
  effective_to?: string;
  rego_plate?: string;
  garage_postcode?: string;
}

export interface NevdisOdometerReading {
  reading_km: number;
  reading_date: string;
  source: 'inspection' | 'service' | 'transfer' | 'auction';
}

export interface NevdisCheckResult {
  provider: string;
  checked_at: string;
  vehicle: {
    vin?: string;
    rego?: string;
    state?: string;
    make?: string;
    model?: string;
    year?: number;
    body?: string;
    colour?: string;
    fuel_type?: string;
    engine_number?: string;
    compliance_date?: string;
    build_date?: string;
  };
  registrations: NevdisRegistrationRecord[];
  written_off: {
    is_write_off: boolean;
    category?: 'statutory' | 'repairable' | 'inspected';
    state?: string;
    damage_description?: string;
    reported_at?: string;
  };
  stolen: { is_stolen: boolean; reported_state?: string; reported_at?: string };
  odometer_history: NevdisOdometerReading[];
  /**
   * Cross-state transfer count — useful red-flag heuristic. A car with 6
   * state-transfers in 4 years is almost always being washed.
   */
  state_transfer_count: number;
  /**
   * Detected odometer rollback — set true if any later reading is lower
   * than an earlier one (basic check, real providers run a richer model).
   */
  odometer_inconsistency: boolean;
  certificate_id: string;
  raw?: Record<string, unknown>;
}

export interface NevdisProvider {
  readonly name: string;
  check(req: NevdisCheckRequest): Promise<NevdisCheckResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Deterministic mock provider
//
//  Same VIN/rego always returns the same payload — important because the
//  Vehicle Intelligence Report is what we sell, and consumers re-pull. Also
//  makes Playwright + integration tests stable.
// ─────────────────────────────────────────────────────────────────────────────

export class MockNevdisProvider implements NevdisProvider {
  readonly name = 'mock';

  async check(req: NevdisCheckRequest): Promise<NevdisCheckResult> {
    const seed = (req.vin || req.rego || 'unknown').toUpperCase();
    const hash = [...seed].reduce((acc, c) => (acc * 33 + c.charCodeAt(0)) >>> 0, 5381);

    // Use the same risk distributions as the PPSR mock so the two stay
    // internally consistent. (Real providers cross-corroborate too.)
    const isWriteOff = (hash % 17) === 0;
    const isStolen = (hash % 97) === 0;
    const transferCount = (hash % 6); // 0–5 typical
    const odoBase = 30_000 + (hash % 180_000);

    // Build a plausible odometer history. ~3% of mocks include a rollback
    // signal (later reading < earlier reading) so the UI can demo the
    // inconsistency badge meaningfully.
    const rolledBack = (hash % 31) === 0;
    const odoReadings: NevdisOdometerReading[] = [
      { reading_km: odoBase, reading_date: '2021-06-14', source: 'service' },
      { reading_km: odoBase + 18_500, reading_date: '2022-08-22', source: 'service' },
      {
        reading_km: rolledBack ? odoBase + 8_000 : odoBase + 41_300,
        reading_date: '2024-01-18',
        source: 'transfer',
      },
      { reading_km: (rolledBack ? odoBase + 12_400 : odoBase + 58_900), reading_date: '2025-09-04', source: 'inspection' },
    ];

    const states: Array<'NSW' | 'VIC' | 'QLD' | 'WA' | 'SA' | 'TAS' | 'ACT' | 'NT'> = [
      'NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT',
    ];
    const stateA = states[hash % states.length]!;
    const stateB = states[(hash >> 3) % states.length]!;

    const regos: NevdisRegistrationRecord[] = transferCount === 0
      ? [{ state: req.state ?? stateA, status: 'current', effective_from: '2018-04-02', rego_plate: req.rego }]
      : [
          { state: stateA, status: 'expired', effective_from: '2016-08-21', effective_to: '2020-12-04' },
          { state: stateB, status: 'expired', effective_from: '2020-12-05', effective_to: '2023-04-19' },
          { state: req.state ?? stateA, status: 'current', effective_from: '2023-04-20', rego_plate: req.rego },
        ];

    const certId = `NEVDIS-MOCK-${seed.slice(-6)}-${(hash & 0xffff).toString(16).toUpperCase()}`;

    return {
      provider: this.name,
      checked_at: new Date().toISOString(),
      vehicle: { vin: req.vin, rego: req.rego, state: req.state },
      registrations: regos,
      written_off: isWriteOff
        ? {
            is_write_off: true,
            category: 'repairable',
            state: stateA,
            damage_description: 'Hail event — major panel + glass damage. Repaired and re-inspected.',
            reported_at: '2022-11-01T00:00:00Z',
          }
        : { is_write_off: false },
      stolen: isStolen
        ? { is_stolen: true, reported_state: stateA, reported_at: '2024-02-19T00:00:00Z' }
        : { is_stolen: false },
      odometer_history: odoReadings,
      state_transfer_count: transferCount,
      odometer_inconsistency: rolledBack,
      certificate_id: certId,
      raw: { mock: true },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Real reseller adapter — placeholders. Implement when credentials exist.
//
//  Both CarHistory + InfoTrack expose REST endpoints; payload shapes differ
//  but both can be mapped onto `NevdisCheckResult`. Keep the mapping logic
//  in the provider classes so the report runner doesn't need to care.
// ─────────────────────────────────────────────────────────────────────────────

export class CarHistoryNevdisProvider implements NevdisProvider {
  readonly name = 'carhistory';
  constructor(private readonly opts: { apiKey: string; baseUrl?: string }) {}

  async check(_req: NevdisCheckRequest): Promise<NevdisCheckResult> {
    void this.opts;
    throw new Error('CarHistoryNevdisProvider not implemented — wire up real API once contract signed.');
  }
}

export class InfoTrackNevdisProvider implements NevdisProvider {
  readonly name = 'infotrack-nevdis';
  constructor(private readonly opts: { apiKey: string; baseUrl?: string }) {}

  async check(_req: NevdisCheckRequest): Promise<NevdisCheckResult> {
    void this.opts;
    throw new Error('InfoTrackNevdisProvider not implemented — supply credentials.');
  }
}

let cached: NevdisProvider | null = null;

export function getNevdisProvider(): NevdisProvider {
  if (cached) return cached;
  const choice = (process.env.NEVDIS_PROVIDER || 'mock').toLowerCase();
  if (choice === 'carhistory' && process.env.CARHISTORY_API_KEY) {
    cached = new CarHistoryNevdisProvider({ apiKey: process.env.CARHISTORY_API_KEY });
  } else if (choice === 'infotrack' && process.env.INFOTRACK_API_KEY) {
    cached = new InfoTrackNevdisProvider({ apiKey: process.env.INFOTRACK_API_KEY });
  } else {
    cached = new MockNevdisProvider();
  }
  return cached;
}

/**
 * For tests: reset the cached singleton so a fresh env can be wired.
 */
export function _resetNevdisProvider() {
  cached = null;
}
