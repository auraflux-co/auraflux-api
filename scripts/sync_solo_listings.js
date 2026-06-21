#!/usr/bin/env node
'use strict';
/**
 * Sync solo YouTube listing titles from live Twitch grid — no Render deploy required.
 *
 * Reads grid state from the broadcast sidecar (who is on Q1–Q4), discovers YouTube
 * broadcast IDs by ingest stream key, pushes title + description via local OAuth.
 *
 * Usage:
 *   node scripts/sync_solo_listings.js
 *   node scripts/sync_solo_listings.js --quadrant 4
 *   node scripts/sync_solo_listings.js --sidecar https://auraflux-broadcast-staging.onrender.com --dry-run
 *
 * Env: BROADCAST_SIDECAR_URL (default staging sidecar), YouTube OAuth in .env (same as sidecar channel).
 */

require('dotenv').config();

const axios = require('axios');
const yt = require('../lib/services/youtube_direct');
const { syncSoloListingsFromGrid } = require('../lib/live_grid/solo_listing_sync');

function parseArgs(argv) {
  const out = { quadrants: null, dryRun: false, lite: false, sidecar: process.env.BROADCAST_SIDECAR_URL || 'https://auraflux-broadcast-staging.onrender.com' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--lite') out.lite = true;
    else if (a === '--quadrant' || a === '-q') {
      const n = parseInt(argv[++i], 10);
      if (Number.isInteger(n)) out.quadrants = [...(out.quadrants || []), n];
    }
    else if (a === '--sidecar') out.sidecar = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function fetchJson(url) {
  const { data } = await axios.get(url, { timeout: 30_000 });
  return data;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node scripts/sync_solo_listings.js [--quadrant N]... [--sidecar URL] [--dry-run]`);
    process.exit(0);
  }

  const base = String(args.sidecar || '').replace(/\/$/, '');
  console.log(`Sidecar: ${base}`);

  const status = await fetchJson(`${base}/live-grid/status`);
  if (!status.running) {
    console.error('Live grid is not running on sidecar.');
    process.exit(1);
  }

  let discovered = null;
  try {
    discovered = await fetchJson(`${base}/live-grid/discover-broadcasts`);
    if (discovered?.soloBroadcastIds) {
      console.log('Discovered solo IDs:', JSON.stringify(discovered.soloBroadcastIds));
    }
  } catch (e) {
    console.warn(`Discover skipped (${e.response?.status || e.message}) — using status broadcast IDs`);
  }

  if (!yt.isConnected()) {
    console.error('YouTube OAuth not connected locally — authorize via Broadcast page or set tokens in .env');
    process.exit(1);
  }

  const result = await syncSoloListingsFromGrid({
    status,
    discovered,
    yt,
    quadrants: args.quadrants,
    dryRun: args.dryRun,
    mode: args.lite ? 'lite' : 'discoverable',
    log: (m) => console.log(m),
  });

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.response?.data?.error?.message || e.message);
  process.exit(1);
});
