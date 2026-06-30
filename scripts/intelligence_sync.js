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

  const sync = await intelligence.syncPerformance('youtube', { days: 28, limit });
  const ok = (sync.results || []).filter((r) => r.ok).length;
  const fail = (sync.results || []).filter((r) => !r.ok).length;
  console.log('[intelligence_sync] sync ok=%s fail=%s reconcile updated=%s',
    ok, fail, sync.reconcile?.updated || 0);

  process.exit(0);
}

main().catch((e) => {
  console.error('[intelligence_sync] fatal:', e.message);
  process.exit(1);
});
