#!/usr/bin/env node
'use strict';
/**
 * CPD-1067 — Monitor solo roster fleet for Tier C encode health on both sidecars.
 *
 * Watches fleetOrchestrator slot phases, solo encoder contract (6800k @ 1080p),
 * YouTube ingest health, and solo publisher restarts. Logs alerts to JSONL.
 *
 * Usage:
 *   node scripts/monitor_fleet_tier_c.js
 *   MONITOR_INTERVAL_SEC=45 node scripts/monitor_fleet_tier_c.js
 *
 * Env:
 *   MONITOR_INTERVAL_SEC=45
 *   FLEET_TIER_C_LOG=logs/fleet_tier_c_watch.jsonl
 *   SIDECAR_A_URL / SIDECAR_B_URL — override fleet config URLs
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { loadFleetConfig } = require('../lib/live_grid/solo_roster_fleet');
const yt = require('../lib/services/youtube_direct');

const INTERVAL_MS = Math.max(30, parseInt(process.env.MONITOR_INTERVAL_SEC || '45', 10)) * 1000;
const LOG = process.env.FLEET_TIER_C_LOG
  || path.join(__dirname, '..', 'logs', 'fleet_tier_c_watch.jsonl');
const TIER_C_BITRATE_K = 6800;
const TIER_C_W = 1920;
const TIER_C_H = 1080;

const lastRestartTotal = new Map();
const lastPhase = new Map();

function sidecarUrls() {
  const cfg = loadFleetConfig();
  return (cfg.sidecars || []).map((s) => ({
    fleetId: s.id,
    url: (s.id === 'a' ? process.env.SIDECAR_A_URL : process.env.SIDECAR_B_URL) || s.url,
  }));
}

function log(row) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  const tag = row.alerts?.length ? 'ALERT' : 'ok';
  const live = row.slots?.filter((s) => s.phase === 'live').length ?? 0;
  console.log(`[fleet-tier-c:${row.fleetId}] ${tag} ${live} live / ${row.slots?.length ?? 0} active${row.alerts?.length ? ` — ${row.alerts.join('; ')}` : ''}`);
}

function soloContractOk(solo) {
  if (!solo?.running) return { ok: false, reason: 'encoder_not_running' };
  const w = solo.w ?? solo.outputW;
  const h = solo.h ?? solo.outputH;
  const br = solo.bitrateK ?? solo.bitrate;
  const issues = [];
  if (w && w < TIER_C_W) issues.push(`width ${w}<${TIER_C_W}`);
  if (h && h < TIER_C_H) issues.push(`height ${h}<${TIER_C_H}`);
  if (br && br < TIER_C_BITRATE_K * 0.9) issues.push(`bitrate ${br}k<${TIER_C_BITRATE_K}k`);
  return { ok: issues.length === 0, issues };
}

async function fetchSidecar(url) {
  const base = url.replace(/\/$/, '');
  const { data: status } = await axios.get(`${base}/live-grid/status`, { timeout: 20_000 });
  return { base, status };
}

async function checkYoutubeIngest(broadcastId, streamId) {
  if (!yt.isConnected() || !streamId) return null;
  try {
    const health = await yt.getLiveStreamHealth(streamId);
    return health;
  } catch (e) {
    return { error: e.message };
  }
}

async function tickSidecar({ fleetId, url }) {
  const alerts = [];
  let status;
  try {
    ({ status } = await fetchSidecar(url));
  } catch (e) {
    log({ ts: new Date().toISOString(), fleetId, url, error: e.message, alerts: ['sidecar_unreachable'] });
    return;
  }

  const fleet = status.fleetOrchestrator;
  if (!fleet) {
    if (status.running) alerts.push('grid_running_not_fleet_mode');
    log({ ts: new Date().toISOString(), fleetId, url, running: !!status.running, alerts });
    return;
  }

  const contract = status.encodeContract || {};
  const solos = contract.solos || [];
  const slotRows = [];

  for (const slot of fleet.slots || []) {
    const key = `${fleetId}:${slot.slot}`;
    const prev = lastPhase.get(key);
    if (prev && prev !== slot.phase && slot.phase === 'live') {
      alerts.push(`slot ${slot.slot} @${slot.login} went LIVE`);
    }
    lastPhase.set(key, slot.phase);

    const soloEnc = solos.find((s) => (s.poolSlot ?? s.quadrant) === slot.localPool);
    const row = {
      slot: slot.slot,
      login: slot.login,
      phase: slot.phase,
      broadcastId: slot.broadcastId,
      encoder: soloEnc ? {
        running: soloEnc.running,
        w: soloEnc.w,
        h: soloEnc.h,
        bitrateK: soloEnc.bitrateK,
      } : null,
    };

    if (slot.phase === 'live' || slot.phase === 'starting') {
      if (soloEnc) {
        const chk = soloContractOk(soloEnc);
        if (!chk.ok) alerts.push(`slot ${slot.slot} tier_c: ${chk.reason || chk.issues?.join(', ')}`);
      } else {
        alerts.push(`slot ${slot.slot} live but no solo encoder in contract`);
      }

      if (slot.broadcastId && soloEnc?.streamId) {
        const health = await checkYoutubeIngest(slot.broadcastId, soloEnc.streamId);
        row.youtubeHealth = health;
        if (health?.videoIngestionStarved) {
          alerts.push(`slot ${slot.slot} YouTube videoIngestionStarved`);
        }
      }
    }

    slotRows.push(row);
  }

  const restartTotal = status.soloPublishers?.restartCount
    ?? solos.reduce((n, s) => n + (s.restarts ?? 0), 0);
  const prevRestarts = lastRestartTotal.get(fleetId) ?? 0;
  if (restartTotal > prevRestarts + 1) {
    alerts.push(`solo restarts jumped ${prevRestarts}→${restartTotal}`);
  }
  lastRestartTotal.set(fleetId, restartTotal);

  const liveCount = slotRows.filter((s) => s.phase === 'live').length;
  if (liveCount >= 3 && contract.totals?.configuredVideoBitrateK) {
    const expectedK = liveCount * TIER_C_BITRATE_K;
    if (contract.totals.configuredVideoBitrateK < expectedK * 0.85) {
      alerts.push(`configured video ${contract.totals.configuredVideoBitrateK}k below Tier C target ~${expectedK}k`);
    }
  }

  log({
    ts: new Date().toISOString(),
    fleetId,
    url,
    liveCount,
    restartTotal,
    encodeContract: {
      template: contract.template,
      encoderCount: contract.totals?.encoderCount,
      configuredVideoBitrateK: contract.totals?.configuredVideoBitrateK,
      allMeetYoutube1080p: contract.passHints?.allMeetYoutube1080p,
    },
    slots: slotRows,
    alerts,
  });
}

async function tick() {
  for (const sc of sidecarUrls()) {
    await tickSidecar(sc);
  }
}

async function main() {
  console.log(`[fleet-tier-c] watching ${sidecarUrls().map((s) => s.fleetId).join('+')} every ${INTERVAL_MS / 1000}s → ${LOG}`);
  console.log(`[fleet-tier-c] Tier C target: ${TIER_C_W}x${TIER_C_H} @ ${TIER_C_BITRATE_K}k per live solo`);
  await tick();
  setInterval(() => tick().catch((e) => console.error('[fleet-tier-c] tick failed:', e.message)), INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
