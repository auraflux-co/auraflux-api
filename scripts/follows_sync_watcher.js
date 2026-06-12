#!/usr/bin/env node
/**
 * Follows sync watcher (CPD-972) — near-real-time follow → bench for the
 * RUNNING live grid stream.
 *
 * The currently-broadcasting server process predates the CPD-955 in-server
 * live-sync (and the rename-proof follows lookup), so it cannot refresh the
 * bench from Twitch follows itself until its next restart. This standalone
 * watcher bridges the gap:
 *
 *   every POLL_MS: pull followed logins (fixed user_id lookup) →
 *   diff against data/follows_sync_seen.json →
 *   POST /live-grid/roster { benchAdd: [newly-followed logins] }
 *
 * Only NEWLY-followed logins are added — streamers Rob removed via the
 * dashboard × stay removed (they're in the seen set already). Unfollows are
 * ignored; the × button is the removal path.
 *
 * Retire this watcher after the next server restart — CPD-955 takes over.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getFollowedLogins } = require('../lib/live_grid/follows');

const SEEN_PATH = path.join(__dirname, '..', 'data', 'follows_sync_seen.json');
const BASE = process.env.LIVE_GRID_API || 'http://localhost:3000';
const POLL_MS = Number(process.env.FOLLOWS_SYNC_INTERVAL_MS || 120000);

const log = (msg) => console.log(`[${new Date().toISOString()}] [follows-sync] ${msg}`);

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'))); } catch (_) { return null; }
}
function saveSeen(seen) {
  fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen].sort(), null, 2));
}

async function tick() {
  const follows = await getFollowedLogins();
  let seen = loadSeen();
  if (!seen) {
    // First run: baseline only — never bulk-add (current bench already synced).
    seen = new Set(follows);
    saveSeen(seen);
    log(`baseline: ${follows.length} followed channels recorded`);
    return;
  }

  const fresh = follows.filter(l => !seen.has(l));
  if (!fresh.length) return;

  const status = (await axios.get(`${BASE}/live-grid/status`)).data;
  if (status.running) {
    const roster = new Set(status.poller?.roster || []);
    const toAdd = fresh.filter(l => !roster.has(l));
    if (toAdd.length) {
      await axios.post(`${BASE}/live-grid/roster`, { benchAdd: toAdd });
      log(`new follows benched: ${toAdd.join(', ')}`);
    }
  } else {
    log(`new follows noted (grid offline, will apply at next start): ${fresh.join(', ')}`);
  }
  for (const l of fresh) seen.add(l);
  saveSeen(seen);
}

log(`watching follows every ${POLL_MS / 1000}s → ${BASE}`);
tick().catch(e => log(`tick failed: ${e.response?.data?.message || e.message}`));
setInterval(() => tick().catch(e => log(`tick failed: ${e.response?.data?.message || e.message}`)), POLL_MS);
