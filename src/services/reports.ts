import { db } from '../config/database';
import { reports, type NewReport, type Report } from '../db/schema';
import { eq } from 'drizzle-orm';
import { getPpsrProvider } from './ppsr';
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
  market_value: { low: number; mid: number; high: number; basis: string };
  recommended_action: string;
  generated_at: string;
}

function rangeFromCanonicalMock(make?: string, model?: string, year?: number) {
  // Placeholder market band — replace with real query against canonical + sold history
  const base = 25000 + (year ? Math.max(0, year - 2010) * 1500 : 0);
  return { low: base * 0.85, mid: base, high: base * 1.15, basis: 'mock_pre_partner' };
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
    const ppsr = await getPpsrProvider().check({
      vin: row.requested_vin || undefined,
      rego: row.requested_rego || undefined,
      state: row.requested_state || undefined,
    });

    // We don't yet have NEVDIS, but we can still seed a canonical row from
    // PPSR vehicle hints when present.
    let canonicalId: string | null = row.vehicle_canonical_id;
    if (!canonicalId && (ppsr.vehicle.vin || (ppsr.vehicle.rego && ppsr.vehicle.state))) {
      try {
        const canonical = await upsertCanonical({
          vin: ppsr.vehicle.vin,
          rego: ppsr.vehicle.rego,
          rego_state: ppsr.vehicle.state,
          make: ppsr.vehicle.make || 'Unknown',
          model: ppsr.vehicle.model || 'Unknown',
          year: ppsr.vehicle.year || 2020,
        });
        canonicalId = canonical.id;
      } catch {
        // Canonical insertion is best-effort — never block report delivery.
      }
    }

    const market = rangeFromCanonicalMock(ppsr.vehicle.make, ppsr.vehicle.model, ppsr.vehicle.year);

    const reasons: string[] = [];
    if (ppsr.encumbrances.length > 0) reasons.push(`${ppsr.encumbrances.length} active financial encumbrance(s) — title not clean.`);
    if (ppsr.write_off.is_write_off) reasons.push(`Write-off recorded (${ppsr.write_off.category}) in ${ppsr.write_off.state}.`);
    if (ppsr.stolen.is_stolen) reasons.push('Reported stolen — DO NOT purchase.');

    const headline: ReportSummary['headline'] = ppsr.stolen.is_stolen || ppsr.write_off.is_write_off
      ? 'do_not_buy'
      : ppsr.encumbrances.length > 0
        ? 'caution'
        : 'clear';

    const recommended_action =
      headline === 'do_not_buy'
        ? 'Walk away. The vehicle has a serious recorded issue that will affect title or safety.'
        : headline === 'caution'
          ? 'Negotiate down or insist seller clears encumbrance before settlement (settle through a solicitor).'
          : 'Title appears clean. Compare ask to market range and proceed with standard inspection.';

    const summary: ReportSummary = {
      headline,
      reasons,
      market_value: market,
      recommended_action,
      generated_at: new Date().toISOString(),
    };

    const [updated] = await db
      .update(reports)
      .set({
        status: 'ready',
        ppsr_payload: ppsr as any,
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
