#!/usr/bin/env node
'use strict';
/**
 * Post-deploy fleet roster refresh — sync bindings + labels on Sidecar A and/or B.
 * Run AFTER code deploy when replacing roster streamers (e.g. deen→extraemily, maya→funnymike).
 *
 * Safe while other slots are live: skips slots where the OLD streamer is still live/starting.
 *
 * Usage:
 *   node scripts/apply_fleet_roster_refresh.js [--dry-run] [--sidecar=a|b|both]
 *
 * Requires BROADCAST_OPERATOR_SECRET + roster in config/solo_roster_fleet.json on deployed sidecars.
 */

const axios = require('axios');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { loadFleetConfig, localFleetSlots } = require('../lib/live_grid/solo_roster_fleet');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const sidecarArg = (argv.find((a) => a.startsWith('--sidecar=')) || '--sidecar=both').split('=')[1].toLowerCase();

const SECRET = String(process.env.BROADCAST_OPERATOR_SECRET || '').trim();
if (!SECRET && !DRY) {
  console.error('BROADCAST_OPERATOR_SECRET required in .env');
  process.exit(1);
}

function sidecarsToRun() {
  const cfg = loadFleetConfig();
  const ids = sidecarArg === 'both' ? ['a', 'b'] : [sidecarArg];
  return ids.map((id) => cfg.sidecars.find((s) => s.id === id)).filter(Boolean);
}

async function refreshSidecar(sidecar) {
  const base = sidecar.url.replace(/\/$/, '');
  const url = `${base}/live-grid/fleet/roster-refresh?operator=${encodeURIComponent(SECRET)}`;
  const slots = localFleetSlots(sidecar.id);
  const bindings = Object.fromEntries(slots.map((s) => [s.login, s.localPool]));

  console.log(`\n[${sidecar.id}] ${sidecar.name || sidecar.renderService}`);
  console.log(`  roster: ${slots.map((s) => `@${s.login}→pool${s.localPool}`).join(', ')}`);

  if (DRY) {
    console.log('  [dry-run] would POST /live-grid/fleet/roster-refresh');
    return { ok: true, dryRun: true };
  }

  const healthUrl = `${base}/live-grid/fleet/health?operator=${encodeURIComponent(SECRET)}`;
  try {
    const health = await axios.get(healthUrl, { timeout: 15000 });
    const live = (health.data?.health?.slots || []).filter((s) => s.phase === 'live');
    if (live.length) {
      console.log(`  live now: ${live.map((s) => s.label).join(', ')}`);
    }
  } catch (e) {
    console.warn(`  fleet health check skipped: ${e.message}`);
  }

  const { data } = await axios.post(url, { bindings }, {
    timeout: 120000,
    headers: { 'Content-Type': 'application/json' },
  });

  if (!data.ok) throw new Error(data.error || 'roster-refresh failed');
  console.log(`  ✅ ${data.message}`);
  if (data.skipped?.length) {
    for (const row of data.skipped) {
      console.log(`  ⏸ slot ${row.slot}: ${row.oldLogin} still ${row.phase} — wait for logoff before ${row.newLogin}`);
    }
  }
  return data;
}

(async () => {
  const list = sidecarsToRun();
  if (!list.length) {
    console.error(`Unknown sidecar: ${sidecarArg}`);
    process.exit(1);
  }
  console.log(`Fleet roster refresh (${DRY ? 'dry-run' : 'live'}) — ${list.map((s) => s.id).join(', ')}`);
  for (const sc of list) {
    await refreshSidecar(sc);
  }
  console.log('\nDone. Idle slots use new roster; skipped slots refresh automatically when old streamer logs off.');
})().catch((e) => {
  console.error(e.response?.data?.error || e.message);
  process.exit(1);
});
