// ─────────────────────────────────────────────────────────────────────────────
//  Report-ready email — delivered the moment runReport() flips status='ready'.
//
//  Why this exists:
//    The marketing page (vehicle-history-report/page.tsx) promises "delivered
//    in seconds" + "branded PDF you can show the seller". The runReport
//    service composes the JSON summary, but without this module the
//    customer never hears about it until they refresh /report/ready.
//
//  Contract:
//    • Never throws. Email failures are logged + recorded in email_sent_at
//      staying null, so a sweeper can retry later.
//    • Idempotent: if email_sent_at is already populated, skip.
//    • Works in the boot-without-credentials mode — LogEmailProvider fallback
//      means Railway first-boot logs show the email body so we can verify
//      rendering without paying for a Resend key immediately.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from '../config/database';
import { reports } from '../db/schema';
import { eq } from 'drizzle-orm';
import { getEmailProvider } from './email';
import type { ReportSummary } from './reports';

const AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

const HEADLINE_COPY: Record<ReportSummary['headline'], { label: string; colour: string }> = {
  clear: { label: 'Title clean', colour: '#22c55e' },
  caution: { label: 'Proceed with caution', colour: '#f59e0b' },
  do_not_buy: { label: 'Do not buy', colour: '#ef4444' },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

interface RenderInput {
  reportId: string;
  vinOrRego: string;
  summary: ReportSummary;
  viewUrl: string;
}

function renderHtml(input: RenderInput): string {
  const { summary, vinOrRego, viewUrl } = input;
  const head = HEADLINE_COPY[summary.headline];
  const mv = summary.market_value;
  const reg = summary.registration;

  const reasonsHtml = summary.reasons.length
    ? `<ul style="margin:0 0 16px 0;padding-left:20px;color:#444;">
        ${summary.reasons.map((r) => `<li style="margin-bottom:6px;">${escapeHtml(r)}</li>`).join('')}
      </ul>`
    : `<p style="color:#2f855a;margin:0 0 16px 0;">No adverse records found across PPSR + NEVDIS.</p>`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f5f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f5f1;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
            <tr>
              <td style="padding:24px 32px;background:#0a0a0a;color:#f5f5f0;">
                <div style="font-size:12px;letter-spacing:2px;color:#b8956e;text-transform:uppercase;">Vehicle Intelligence Report</div>
                <div style="font-size:22px;font-weight:700;margin-top:4px;">${escapeHtml(vinOrRego)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 8px 32px;">
                <div style="display:inline-block;padding:6px 14px;border-radius:999px;background:${head.colour}15;color:${head.colour};font-weight:600;font-size:13px;letter-spacing:0.4px;text-transform:uppercase;">
                  ${escapeHtml(head.label)}
                </div>
                <h2 style="margin:16px 0 8px 0;font-size:20px;font-weight:600;">Key findings</h2>
                ${reasonsHtml}
                <h3 style="margin:8px 0;font-size:16px;font-weight:600;">Recommended action</h3>
                <p style="margin:0 0 20px 0;color:#333;">${escapeHtml(summary.recommended_action)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e4dc;border-radius:8px;">
                  <tr>
                    <td style="padding:12px 14px;border-bottom:1px solid #eee;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;">Market value range</td>
                    <td style="padding:12px 14px;border-bottom:1px solid #eee;text-align:right;">${AUD.format(mv.low)} – ${AUD.format(mv.high)} <span style="color:#666;">(median ${AUD.format(mv.mid)})</span></td>
                  </tr>
                  <tr>
                    <td style="padding:12px 14px;border-bottom:1px solid #eee;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;">Market basis</td>
                    <td style="padding:12px 14px;border-bottom:1px solid #eee;text-align:right;">${escapeHtml(mv.basis)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 14px;border-bottom:1px solid #eee;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;">Registration path</td>
                    <td style="padding:12px 14px;border-bottom:1px solid #eee;text-align:right;">${reg.states_registered.join(' → ') || '—'}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 14px;border-bottom:1px solid #eee;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;">State transfers</td>
                    <td style="padding:12px 14px;border-bottom:1px solid #eee;text-align:right;">${reg.state_transfer_count}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 14px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;">Odometer check</td>
                    <td style="padding:12px 14px;text-align:right;">${reg.odometer_inconsistency ? '<span style="color:#ef4444;font-weight:600;">Inconsistency detected</span>' : '<span style="color:#22c55e;">Consistent</span>'}${reg.last_known_km ? ` <span style="color:#666;">· last ${reg.last_known_km.toLocaleString('en-AU')} km</span>` : ''}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 32px 32px;text-align:center;">
                <a href="${escapeHtml(viewUrl)}" style="display:inline-block;background:#b8956e;color:#0a0a0a;text-decoration:none;font-weight:600;padding:14px 28px;border-radius:10px;">View the full report</a>
                <p style="font-size:12px;color:#888;margin:16px 0 0 0;">Report generated ${escapeHtml(summary.generated_at)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px;background:#f8f7f2;border-top:1px solid #eee;color:#888;font-size:11px;text-align:center;">
                AutoHarvester · PPSR + NEVDIS + market comps, delivered in seconds.<br>
                Questions? Reply to this email and we&rsquo;ll get back within the hour.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderText(input: RenderInput): string {
  const { summary, vinOrRego, viewUrl } = input;
  const head = HEADLINE_COPY[summary.headline].label;
  const mv = summary.market_value;

  const reasons = summary.reasons.length
    ? summary.reasons.map((r) => `  - ${r}`).join('\n')
    : '  (none — no adverse records found)';

  return [
    `Vehicle Intelligence Report — ${vinOrRego}`,
    `Verdict: ${head}`,
    '',
    'Key findings:',
    reasons,
    '',
    `Recommended action: ${summary.recommended_action}`,
    '',
    `Market value: ${AUD.format(mv.low)} – ${AUD.format(mv.high)} (median ${AUD.format(mv.mid)})`,
    `Market basis: ${mv.basis}`,
    '',
    `Full report: ${viewUrl}`,
    `Generated: ${summary.generated_at}`,
    '',
    '— AutoHarvester',
  ].join('\n');
}

export async function sendReportReadyEmail(reportId: string): Promise<'sent' | 'skipped' | 'failed'> {
  const [row] = await db.select().from(reports).where(eq(reports.id, reportId));
  if (!row) return 'failed';
  if (row.status !== 'ready') return 'skipped';
  if (row.email_sent_at) return 'skipped';
  if (!row.customer_email) {
    console.warn(`[report-email] no customer_email for report ${reportId} — cannot deliver`);
    return 'skipped';
  }

  const summary = row.summary as unknown as ReportSummary;
  if (!summary || !summary.headline) {
    console.warn(`[report-email] summary missing for report ${reportId}`);
    return 'failed';
  }

  const vinOrRego = row.requested_vin
    ? `VIN ${row.requested_vin}`
    : row.requested_rego
      ? `${row.requested_rego} (${row.requested_state ?? '??'})`
      : 'Your vehicle';

  const frontendUrl = (process.env.FRONTEND_URL || 'https://autoharvester.com.au').replace(/\/$/, '');
  const viewUrl = `${frontendUrl}/report/ready?report_id=${encodeURIComponent(row.id)}`;

  const renderInput: RenderInput = {
    reportId: row.id,
    vinOrRego,
    summary,
    viewUrl,
  };

  try {
    const provider = getEmailProvider();
    const result = await provider.send({
      to: row.customer_email,
      subject: `Your Vehicle Intelligence Report — ${summary.headline === 'do_not_buy' ? 'Do not buy' : summary.headline === 'caution' ? 'Caution' : 'All clear'}`,
      html: renderHtml(renderInput),
      text: renderText(renderInput),
      tag: 'report-ready',
    });

    if (result.status === 'failed') {
      console.error(`[report-email] send failed for ${reportId}:`, result.error);
      return 'failed';
    }

    await db
      .update(reports)
      .set({ email_sent_at: new Date() })
      .where(eq(reports.id, reportId));

    console.log(`[report-email] ${result.status} report=${reportId} provider=${result.provider} id=${result.id ?? 'n/a'}`);
    return 'sent';
  } catch (err) {
    console.error(`[report-email] unexpected failure for ${reportId}:`, err);
    return 'failed';
  }
}
