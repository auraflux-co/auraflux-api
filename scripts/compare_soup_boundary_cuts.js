#!/usr/bin/env node
'use strict';

/**
 * Compare long-form Twitch Soup cuts — baseline vs candidate at every segment join.
 *
 * Usage:
 *   node scripts/compare_soup_boundary_cuts.js \
 *     --baseline output/twitch_soup_..._old.mp4 \
 *     --candidate output/twitch_soup_..._new.mp4 \
 *     --job-id script_twitch_1782513992551
 */

const path = require('path');
const {
  parseArgs,
  compareSoupBoundaries,
} = require('../lib/soup_boundary_compare');

const opts = parseArgs(process.argv);
if (opts.help) {
  require('../lib/soup_boundary_compare');
  process.exit(0);
}

compareSoupBoundaries(opts)
  .then((report) => {
    console.log(`\n✅ Boundary compare complete → ${report.outDir}`);
    console.log(`   Duration: ${report.baselineDurationSec}s → ${report.candidateDurationSec}s (${report.durationDeltaSec >= 0 ? '+' : ''}${report.durationDeltaSec}s)`);
    console.log(`   Boundaries: ${report.boundaries.length} | Flagged hard-cut: ${report.flagged.length}`);
    if (report.flagged.length) {
      console.log('\n   Review first:');
      for (const f of report.flagged.slice(0, 8)) {
        console.log(`   • ${f.timestamp} ${f.fromLabel} → ${f.toLabel} (${f.clipPath ? path.basename(f.clipPath) : '—'})`);
      }
    }
    console.log(`\n   Open report: ${path.join(report.outDir, 'report.md')}`);
  })
  .catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
