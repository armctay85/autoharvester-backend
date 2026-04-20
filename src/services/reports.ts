import { db } from '../config/database';
import { reports, type NewReport, type Report } from '../db/schema';
import { eq } from 'drizzle-orm';
import { getPpsrProvider } from './ppsr';
import { getNevdisProvider, type NevdisCheckResult } from './nevdis';
import { currentMarketMedian } from './trend';
import { upsertCanonical, normaliseVin, normaliseRego, normaliseState } from './canonical';

// ─────────────────────────────────────────────────────────────────────────────
//  Vehicle Intelligence Report — the killer SKU.
//
//  $19 one-off. Composes:
//    1. PPSR check (encumbrance, write-off, stolen)
//    2. NEVDIS lookup (registration history) — TODO when reseller picked
//    3. Market value range (from canonical + listings + sold history)
//    4. Suggested action (buy/skip + negotiation hint)
//
//  Cost basis ~$3.40 PPSR + $1-5 NEVDIS = $4-9 → margin >50% at $19.
//  See AUDIT_AND_UPLIFT.md §3.2 surface 1.
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateReportInput {
  user_id?: string | null;
  vin?: string | null;
  rego?: string | null;
  state?: string | null;
  stripe_payment_intent?: string | null;
}

export async function createPendingReport(input: CreateReportInput): Promise<Report> {
  const vin = normaliseVin(input.vin);
  const rego = normaliseRego(input.rego);
  const state = normaliseState(input.state);
  if (!vin && !(rego && state)) {
    throw new Error('report_requires_vin_or_rego_and_state');
  }

  const insert: NewReport = {
    user_id: input.user_id ?? null,
    requested_vin: vin,
    requested_rego: rego,
    requested_state: state,
    status: 'pending',
    stripe_payment_intent: input.stripe_payment_intent ?? null,
    price_cents: 1900,
  };

  const [row] = await db.insert(reports).values(insert).returning();
  if (!row) throw new Error('report_insert_failed');
  return row;
}

export interface ReportSummary {
  headline: 'clear' | 'caution' | 'do_not_buy';
  reasons: string[];
  market_value: { low: number; mid: number; high: number; basis: string; sample_size?: number };
  registration: {
    states_registered: string[];
    state_transfer_count: number;
    odometer_inconsistency: boolean;
    last_known_km?: number;
  };
  recommended_action: string;
  generated_at: string;
}

async function rangeFromMarket(make?: string, model?: string, year?: number) {
  // Try the live market median against the canonical universe first; fall
  // back to a make/year heuristic when there are no comps. The +/- 10%
  // band mirrors the bands used by the dealer alerts engine.
  if (make && model) {
    try {
      const med = await currentMarketMedian(make, model, year ?? null);
      if (med && med > 0) {
        return {
          low: Math.round(med * 0.9),
          mid: Math.round(med),
          high: Math.round(med * 1.1),
          basis: 'live_active_listings_90d',
        };
      }
    } catch {
      // Fall through to heuristic.
    }
  }
  const base = 25000 + (year ? Math.max(0, year - 2010) * 1500 : 0);
  return { low: base * 0.85, mid: base, high: base * 1.15, basis: 'segment_heuristic_no_comps' };
}

function summariseRegistration(nev: NevdisCheckResult): ReportSummary['registration'] {
  const last = nev.odometer_history.at(-1);
  return {
    states_registered: Array.from(new Set(nev.registrations.map((r) => r.state))),
    state_transfer_count: nev.state_transfer_count,
    odometer_inconsistency: nev.odometer_inconsistency,
    last_known_km: last?.reading_km,
  };
}

export async function runReport(reportId: string): Promise<Report> {
  const [row] = await db.select().from(reports).where(eq(reports.id, reportId));
  if (!row) throw new Error('report_not_found');
  if (row.status === 'ready') return row;

  await db
    .update(reports)
    .set({ status: 'fetching' })
    .where(eq(reports.id, reportId));

  try {
    // Run PPSR + NEVDIS in parallel — they're independent providers and
    // jointly compose the certificate body. If NEVDIS fails we still ship
    // the report with PPSR-only findings (clearly flagged).
    const reqLookup = {
      vin: row.requested_vin || undefined,
      rego: row.requested_rego || undefined,
      state: row.requested_state || undefined,
    };
    const [ppsrRes, nevdisRes] = await Promise.allSettled([
      getPpsrProvider().check(reqLookup),
      getNevdisProvider().check(reqLookup),
    ]);

    if (ppsrRes.status !== 'fulfilled') throw ppsrRes.reason;
    const ppsr = ppsrRes.value;
    const nevdis = nevdisRes.status === 'fulfilled' ? nevdisRes.value : null;

    // Seed canonical row from the richer of (NEVDIS, PPSR) vehicle hints.
    let canonicalId: string | null = row.vehicle_canonical_id;
    const vehicleHints = nevdis?.vehicle ?? ppsr.vehicle;
    if (!canonicalId && (vehicleHints.vin || (vehicleHints.rego && vehicleHints.state))) {
      try {
        const canonical = await upsertCanonical({
          vin: vehicleHints.vin,
          rego: vehicleHints.rego,
          rego_state: vehicleHints.state,
          make: vehicleHints.make || 'Unknown',
          model: vehicleHints.model || 'Unknown',
          year: vehicleHints.year || 2020,
        });
        canonicalId = canonical.id;
      } catch {
        // Canonical insertion is best-effort — never block report delivery.
      }
    }

    const market = await rangeFromMarket(vehicleHints.make, vehicleHints.model, vehicleHints.year);

    // Compose the human-readable findings.
    const reasons: string[] = [];
    if (ppsr.encumbrances.length > 0)
      reasons.push(`${ppsr.encumbrances.length} active financial encumbrance(s) — title not clean.`);
    if (ppsr.write_off.is_write_off)
      reasons.push(`Write-off recorded (${ppsr.write_off.category}) in ${ppsr.write_off.state}.`);
    if (ppsr.stolen.is_stolen) reasons.push('Reported stolen — DO NOT purchase.');
    if (nevdis?.odometer_inconsistency)
      reasons.push('Odometer inconsistency detected across registration history — possible rollback.');
    if (nevdis && nevdis.state_transfer_count >= 4)
      reasons.push(
        `Vehicle has been transferred between ${nevdis.state_transfer_count} states — unusually high mobility, investigate provenance.`
      );
    if (nevdis?.written_off.is_write_off && !ppsr.write_off.is_write_off)
      reasons.push(
        `NEVDIS records a write-off (${nevdis.written_off.category}) in ${nevdis.written_off.state}; not yet visible on PPSR.`
      );

    const isStolen = ppsr.stolen.is_stolen || !!nevdis?.stolen.is_stolen;
    const isWriteOff = ppsr.write_off.is_write_off || !!nevdis?.written_off.is_write_off;
    const isEncumbered = ppsr.encumbrances.length > 0;
    const odoBad = !!nevdis?.odometer_inconsistency;

    const headline: ReportSummary['headline'] = isStolen || isWriteOff
      ? 'do_not_buy'
      : isEncumbered || odoBad
        ? 'caution'
        : 'clear';

    const recommended_action =
      headline === 'do_not_buy'
        ? 'Walk away. The vehicle has a serious recorded issue that will affect title, safety or insurability.'
        : headline === 'caution'
          ? 'Negotiate down (or insist seller clears the encumbrance / proves odometer history) before settlement. Settle through a solicitor.'
          : 'Title appears clean. Compare ask to market range and proceed with standard inspection.';

    const summary: ReportSummary = {
      headline,
      reasons,
      market_value: market,
      registration: nevdis
        ? summariseRegistration(nevdis)
        : {
            states_registered: row.requested_state ? [row.requested_state] : [],
            state_transfer_count: 0,
            odometer_inconsistency: false,
          },
      recommended_action,
      generated_at: new Date().toISOString(),
    };

    const [updated] = await db
      .update(reports)
      .set({
        status: 'ready',
        ppsr_payload: ppsr as any,
        nevdis_payload: (nevdis ?? { error: nevdisRes.status === 'rejected' ? String((nevdisRes as PromiseRejectedResult).reason?.message || nevdisRes.reason) : 'not_run' }) as any,
        market_value_payload: market as any,
        summary: summary as any,
        vehicle_canonical_id: canonicalId,
        completed_at: new Date(),
      })
      .where(eq(reports.id, reportId))
      .returning();

    if (!updated) throw new Error('report_update_failed');
    return updated;
  } catch (err: any) {
    const [failed] = await db
      .update(reports)
      .set({
        status: 'failed',
        error_message: String(err?.message || err),
      })
      .where(eq(reports.id, reportId))
      .returning();
    if (!failed) throw err;
    return failed;
  }
}

export async function getReport(reportId: string): Promise<Report | null> {
  const [row] = await db.select().from(reports).where(eq(reports.id, reportId));
  return row ?? null;
}
