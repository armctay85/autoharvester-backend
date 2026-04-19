// ─────────────────────────────────────────────────────────────────────────────
//  PPSR adapter (scaffold)
//
//  PPSR = Personal Property Securities Register. The single most valuable
//  legitimate AU vehicle data source — encumbrance, write-off, stolen status.
//
//  The official Government PPSR API is fronted by approved resellers:
//    • InfoTrack       — best DX, ~$3.40/check
//    • GlobalX         — comparable
//    • Equifax / CITEC — enterprise, KYC-heavy
//
//  This file ships a typed adapter interface and a `MockPpsrProvider` so the
//  Vehicle Intelligence Report flow can be developed end-to-end without
//  credentials. Swap in `InfoTrackPpsrProvider` once a reseller account is
//  active. Configure via env: PPSR_PROVIDER=infotrack|globalx|mock
//
//  See AUDIT_AND_UPLIFT.md §4.1
// ─────────────────────────────────────────────────────────────────────────────

export interface PpsrCheckRequest {
  vin?: string;
  rego?: string;
  state?: string;
}

export interface PpsrEncumbrance {
  secured_party: string;
  registration_kind: string;
  registered_at: string;
  expires_at?: string;
}

export interface PpsrWriteOff {
  is_write_off: boolean;
  category?: 'repairable' | 'statutory' | 'inspected';
  state?: string;
  reported_at?: string;
}

export interface PpsrCheckResult {
  provider: string;
  checked_at: string;
  vehicle: {
    vin?: string;
    rego?: string;
    state?: string;
    make?: string;
    model?: string;
    year?: number;
  };
  encumbrances: PpsrEncumbrance[];
  write_off: PpsrWriteOff;
  stolen: { is_stolen: boolean; reported_state?: string; reported_at?: string };
  certificate_id: string;
  raw?: Record<string, unknown>;
}

export interface PpsrProvider {
  readonly name: string;
  check(req: PpsrCheckRequest): Promise<PpsrCheckResult>;
}

/**
 * Deterministic mock provider — used for dev + QA + previews.
 * Same VIN always returns the same result so tests are stable.
 */
export class MockPpsrProvider implements PpsrProvider {
  readonly name = 'mock';

  async check(req: PpsrCheckRequest): Promise<PpsrCheckResult> {
    const seed = (req.vin || req.rego || 'unknown').toUpperCase();
    const hash = [...seed].reduce((acc, c) => (acc * 33 + c.charCodeAt(0)) >>> 0, 5381);
    const hasEncumbrance = (hash % 5) === 0; // ~20% have an encumbrance
    const isWriteOff = (hash % 17) === 0;    // ~6% are write-offs
    const isStolen = (hash % 97) === 0;      // ~1% stolen
    const certId = `MOCK-${seed.slice(-6)}-${(hash & 0xffff).toString(16).toUpperCase()}`;

    return {
      provider: this.name,
      checked_at: new Date().toISOString(),
      vehicle: { vin: req.vin, rego: req.rego, state: req.state },
      encumbrances: hasEncumbrance
        ? [{
            secured_party: 'Macquarie Leasing Pty Limited',
            registration_kind: 'PMSI - Motor Vehicle',
            registered_at: '2023-08-12T03:14:22Z',
            expires_at: '2030-08-12T03:14:22Z',
          }]
        : [],
      write_off: isWriteOff
        ? { is_write_off: true, category: 'repairable', state: req.state, reported_at: '2022-11-01T00:00:00Z' }
        : { is_write_off: false },
      stolen: isStolen
        ? { is_stolen: true, reported_state: req.state, reported_at: '2024-02-19T00:00:00Z' }
        : { is_stolen: false },
      certificate_id: certId,
      raw: { mock: true },
    };
  }
}

/**
 * Real reseller adapter — placeholder. Implement once credentials exist.
 * See https://infotrack.com.au/products/ppsr/ for the live spec.
 */
export class InfoTrackPpsrProvider implements PpsrProvider {
  readonly name = 'infotrack';

  constructor(private readonly opts: { apiKey: string; baseUrl?: string }) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async check(req: PpsrCheckRequest): Promise<PpsrCheckResult> {
    throw new Error('InfoTrackPpsrProvider not implemented — supply credentials and wire up the real call.');
  }
}

let cached: PpsrProvider | null = null;

export function getPpsrProvider(): PpsrProvider {
  if (cached) return cached;
  const choice = (process.env.PPSR_PROVIDER || 'mock').toLowerCase();
  if (choice === 'infotrack' && process.env.INFOTRACK_API_KEY) {
    cached = new InfoTrackPpsrProvider({ apiKey: process.env.INFOTRACK_API_KEY });
  } else {
    cached = new MockPpsrProvider();
  }
  return cached;
}
