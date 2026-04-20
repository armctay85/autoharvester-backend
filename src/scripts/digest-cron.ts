// ─────────────────────────────────────────────────────────────────────────────
//  Watchlist digest cron entrypoint
//
//  Run weekly via Railway cron / external scheduler:
//
//    0 8 * * 1   node --import tsx src/scripts/digest-cron.ts
//
//  (Mondays 08:00 — feels like a "fresh week of watchlist" check-in.)
//
//  Optional flags via env:
//    DIGEST_WINDOW_DAYS=7        # how far back to scan
//    DIGEST_DRY_RUN=true         # render but don't send
//
//  Exits 0 on success, non-zero on failure (so Railway/whatever can alert).
// ─────────────────────────────────────────────────────────────────────────────

import { runWatchlistDigest } from '../services/digest';

async function main() {
  const windowDays = Number(process.env.DIGEST_WINDOW_DAYS || 7);
  const dryRun = (process.env.DIGEST_DRY_RUN || 'false').toLowerCase() === 'true';
  const startedAt = Date.now();
  console.log(`[digest-cron] starting window=${windowDays}d dryRun=${dryRun}`);
  const result = await runWatchlistDigest(windowDays, dryRun);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const sent = result.sends.filter((s) => s.result.status === 'sent').length;
  const failed = result.sends.filter((s) => s.result.status === 'failed').length;
  const logged = result.sends.filter((s) => s.result.status === 'logged').length;
  console.log(
    `[digest-cron] done in ${elapsed}s users=${result.totalUsers} alerts=${result.totalAlerts} listings=${result.totalListingsSurfaced} sent=${sent} logged=${logged} failed=${failed}`
  );
  if (failed > 0) {
    console.error(
      '[digest-cron] failures:',
      result.sends.filter((s) => s.result.status === 'failed').map((s) => `${s.email}: ${s.result.error}`)
    );
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error('[digest-cron] fatal', err);
  process.exit(1);
});
