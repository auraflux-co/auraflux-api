#!/usr/bin/env node
'use strict';
/**
 * CPD-1197 — Pull YouTube analytics into Content Memory + reconcile decision outcomes.
 * Usage: node scripts/intelligence_sync.js [--backfill] [--limit N]
 */

const intelligence = require('../lib/intelligence');

async function main() {
  const args = process.argv.slice(2);
  const doBackfill = args.includes('--backfill');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) || 50 : 50;

  if (doBackfill) {
    const backfill = intelligence.backfillFromJobs({ limit: Math.max(limit, 100) });
    console.log('[intelligence_sync] backfill scanned=%s ok=%s',
      backfill.scanned,
      backfill.results.filter((r) => r.ok).length);
  }

  // CPD-1209 — competitor catalog sync (yt-dlp, slow — opt-in flag)
  if (args.includes('--competitors')) {
    try {
      const competitors = require('../lib/intelligence/competitors');
      const comp = await competitors.syncCompetitors();
      for (const r of comp.results) {
        console.log('[intelligence_sync] competitor %s: %s', r.channel, r.ok ? `${r.fetched} fetched, ${r.new} new` : `FAIL ${r.error}`);
      }
      if (comp.newVideos.length) {
        console.log('[intelligence_sync] competitor upload alerts: %s new videos', comp.newVideos.length);
      }
    } catch (e) {
      console.error('[intelligence_sync] competitor sync failed:', e.message);
    }
  }

  const sync = await intelligence.syncPerformance('youtube', { days: 28, limit });
  const ok = (sync.results || []).filter((r) => r.ok).length;
  const fail = (sync.results || []).filter((r) => !r.ok).length;
  console.log('[intelligence_sync] sync ok=%s fail=%s reconcile updated=%s',
    ok, fail, sync.reconcile?.updated || 0);

  // CPD-1208 — rotate any due A/B tests (24h periods)
  try {
    const ab = require('../lib/intelligence/ab_rotation');
    const rotation = await ab.rotateDue();
    if (rotation.rotated > 0) {
      console.log('[intelligence_sync] ab rotated=%s', rotation.rotated);
      for (const r of rotation.results) {
        console.log('  test %s → %s%s', r.testId, r.status || 'running',
          r.winner ? ` winner=${r.winner}` : ` active=${r.activeVariant}`);
      }
    }
  } catch (e) {
    console.error('[intelligence_sync] ab rotation failed:', e.message);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('[intelligence_sync] fatal:', e.message);
  process.exit(1);
});
