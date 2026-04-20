// ─────────────────────────────────────────────────────────────────────────────
//  Pure digest HTML renderer
//
//  Lives separately from digest.ts so it can be unit-tested without pulling
//  the DB / env-validation transitive imports. Same pattern as trend-math.ts
//  vs trend.ts. The DB-aware service in digest.ts re-exports renderDigestHtml
//  from here for backwards compatibility.
// ─────────────────────────────────────────────────────────────────────────────

const FRONTEND_FALLBACK = 'https://autoharvester.com.au';

const FORMAT_AUD = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
  maximumFractionDigits: 0,
});

const fmtAud = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : FORMAT_AUD.format(n);

export interface DigestListing {
  id: string;
  make: string;
  model: string;
  year: number;
  price: number | null;
  odometer: number | null;
  state: string | null;
  location: string | null;
  url: string;
  first_seen_at: Date;
}

export interface DigestAlertLike {
  make: string | null;
  model: string | null;
  year_min: number | null;
  year_max: number | null;
  price_max: number | null;
  state: string | null;
}

export interface DigestSection {
  alert: DigestAlertLike;
  fresh: DigestListing[];
  bestValue: DigestListing[];
  trend: {
    direction: string;
    velocityPctPerMonth: number | null;
    medianPrice: number | null;
    sampleSize: number;
  };
}

function listingRowHtml(l: DigestListing): string {
  const subtitle = [
    l.odometer != null ? `${l.odometer.toLocaleString('en-AU')} km` : null,
    l.location || l.state,
  ]
    .filter(Boolean)
    .join(' · ');
  return `
    <tr>
      <td style="padding:12px 0;border-top:1px solid #2a2a2a">
        <a href="${l.url}" style="color:#f5f5f0;text-decoration:none;font-weight:600">
          ${l.year} ${l.make} ${l.model}
        </a>
        <div style="color:#a0a0a0;font-size:12px;margin-top:2px">${subtitle}</div>
      </td>
      <td style="padding:12px 0;border-top:1px solid #2a2a2a;text-align:right;color:#b8956e;font-weight:700">
        ${fmtAud(l.price)}
      </td>
    </tr>
  `;
}

function trendBadge(t: DigestSection['trend']): string {
  if (t.direction === 'upswing')
    return `<span style="color:#4ade80;font-weight:600">▲ rising ${t.velocityPctPerMonth?.toFixed(1)}%/mo</span>`;
  if (t.direction === 'downswing')
    return `<span style="color:#f87171;font-weight:600">▼ softening ${Math.abs(t.velocityPctPerMonth ?? 0).toFixed(1)}%/mo</span>`;
  if (t.direction === 'flat')
    return `<span style="color:#facc15;font-weight:600">▬ holding flat</span>`;
  return `<span style="color:#a0a0a0">building baseline</span>`;
}

export interface RenderDigestOpts {
  firstName: string;
  windowLabel: string;
  sections: DigestSection[];
  frontendUrl?: string;
}

export function renderDigestHtml(opts: RenderDigestOpts): string {
  const FRONTEND = (opts.frontendUrl || FRONTEND_FALLBACK).replace(/\/$/, '');
  const totalFresh = opts.sections.reduce((s, x) => s + x.fresh.length, 0);
  const sectionHtml = opts.sections
    .map((s) => {
      const a = s.alert;
      const title = [a.make, a.model].filter(Boolean).join(' ') || 'Custom watchlist';
      const filterBits = [
        a.year_min || a.year_max ? `${a.year_min ?? '…'}–${a.year_max ?? '…'}` : null,
        a.price_max ? `≤ ${fmtAud(a.price_max)}` : null,
        a.state || null,
      ]
        .filter(Boolean)
        .join(' · ');

      if (s.fresh.length === 0 && s.bestValue.length === 0) {
        return `
          <div style="margin-top:32px">
            <h2 style="font-size:18px;color:#f5f5f0;margin:0 0 4px">${title}</h2>
            <div style="color:#a0a0a0;font-size:13px;margin-bottom:12px">${filterBits} · ${trendBadge(s.trend)}</div>
            <p style="color:#a0a0a0;font-size:14px">Nothing new this week. We'll keep watching.</p>
          </div>
        `;
      }

      const freshTbl = s.fresh.length
        ? `
          <p style="color:#c8c8c0;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin:16px 0 4px">New this week</p>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
            ${s.fresh.slice(0, 5).map(listingRowHtml).join('')}
          </table>`
        : '';

      const bestTbl = s.bestValue.length
        ? `
          <p style="color:#c8c8c0;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin:20px 0 4px">Best value listings</p>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
            ${s.bestValue.map(listingRowHtml).join('')}
          </table>`
        : '';

      return `
        <div style="margin-top:32px">
          <h2 style="font-size:18px;color:#f5f5f0;margin:0 0 4px">${title}</h2>
          <div style="color:#a0a0a0;font-size:13px;margin-bottom:8px">${filterBits} · ${trendBadge(s.trend)}</div>
          <div style="color:#a0a0a0;font-size:13px;margin-bottom:12px">Market median: ${fmtAud(s.trend.medianPrice)} (${s.trend.sampleSize} comps)</div>
          ${freshTbl}
          ${bestTbl}
        </div>
      `;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
  <meta charset="UTF-8" />
  <title>Your Autoharvester weekly</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#f5f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a0a0a">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%">
          <tr>
            <td>
              <p style="color:#b8956e;font-size:12px;text-transform:uppercase;letter-spacing:2px;margin:0 0 6px">Autoharvester · Weekly</p>
              <h1 style="font-size:24px;color:#f5f5f0;margin:0 0 8px">G'day ${opts.firstName},</h1>
              <p style="color:#c8c8c0;font-size:15px;line-height:1.55;margin:0 0 4px">
                Here's what moved on your watchlist over the last ${opts.windowLabel}. We've spotted
                <strong>${totalFresh}</strong> fresh listings matching your criteria.
              </p>

              ${sectionHtml}

              <div style="margin-top:40px;padding-top:24px;border-top:1px solid #2a2a2a">
                <a href="${FRONTEND}/dashboard" style="display:inline-block;background:#b8956e;color:#0a0a0a;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">
                  Open dashboard
                </a>
                <p style="color:#808080;font-size:12px;margin:24px 0 4px">
                  You're getting this because you have active price alerts on Autoharvester.
                  <a href="${FRONTEND}/dashboard/alerts" style="color:#b8956e">Manage alerts</a>.
                </p>
                <p style="color:#808080;font-size:12px;margin:0">
                  Pricing is indicative and updated continuously from listings, sold records, and dealer feeds.
                </p>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
