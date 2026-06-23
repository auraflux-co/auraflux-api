#!/usr/bin/env node
'use strict';
/**
 * Poll YouTube concurrentViewers for main + solo streams; alert on sharp drops.
 *
 * Usage:
 *   node scripts/monitor_live_concurrent.js
 *   LIVE_SIDECAR_URL=... MONITOR_INTERVAL_SEC=60 node scripts/monitor_live_concurrent.js
 *
 * Env:
 *   MONITOR_INTERVAL_SEC=60
 *   CONCURRENT_DROP_PCT=0.40   — alert if viewers fall this fraction vs prior tick
 *   CONCURRENT_DROP_MIN=5      — minimum absolute drop to alert (noise filter)
 *   CONCURRENT_MIN_BASE=8      — only pct-drop alert when prior >= this
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const yt = require('../lib/services/youtube_direct');

const SIDECAR = (process.env.LIVE_SIDECAR_URL || 'https://auraflux-broadcast-staging.onrender.com').replace(/\/$/, '');
const INTERVAL_MS = Math.max(30, parseInt(process.env.MONITOR_INTERVAL_SEC || '60', 10)) * 1000;
const DROP_PCT = parseFloat(process.env.CONCURRENT_DROP_PCT || '0.40');
const DROP_MIN = parseInt(process.env.CONCURRENT_DROP_MIN || '5', 10);
const MIN_BASE = parseInt(process.env.CONCURRENT_MIN_BASE || '8', 10);
const LOG = path.join(__dirname, '..', 'logs', 'concurrent_watch.jsonl');

const last = new Map();

function log(row) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  const tag = row.alert ? 'ALERT' : 'ok';
  const cc = row.concurrentViewers != null ? row.concurrentViewers : '—';
  console.log(`[concurrent:${row.label}] ${tag} ${cc} viewers${row.alert ? ` — ${row.alert}` : ''}`);
}

async function discoverStreams() {
  const out = [];
  const status = (await axios.get(`${SIDECAR}/live-grid/status`, { timeout: 15000 })).data;
  const mainId = status?.broadcast?.id;
  if (mainId) out.push({ label: 'MAIN', broadcastId: mainId });
  try {
    const solo = (await axios.get(`${SIDECAR}/live-grid/solo-listings`, { timeout: 15000 })).data;
    for (const row of solo?.listings || []) {
      if (!row?.broadcastId) continue;
      out.push({ label: `Q${row.quadrant}`, broadcastId: row.broadcastId });
    }
  } catch (_) {}
  return out;
}

function checkDrop(label, prev, cur) {
  if (prev == null || cur == null) return null;
  if (prev < MIN_BASE) return null;
  const delta = prev - cur;
  if (delta < DROP_MIN) return null;
  const pct = delta / prev;
  if (pct >= DROP_PCT) {
    return `drop ${prev}→${cur} (−${Math.round(pct * 100)}%)`;
  }
  return null;
}

async function tick() {
  if (!yt.isConnected()) {
    console.error('[concurrent] YouTube API not connected — set YOUTUBE_* tokens in .env');
    return;
  }
  let streams;
  try {
    streams = await discoverStreams();
  } catch (e) {
    console.error('[concurrent] sidecar discover failed:', e.message);
    return;
  }
  if (!streams.length) {
    console.log('[concurrent] no broadcast IDs from sidecar');
    return;
  }

  for (const { label, broadcastId } of streams) {
    try {
      const snap = await yt.getLiveConcurrentViewers(broadcastId);
      const key = `${label}:${broadcastId}`;
      const prev = last.get(key);
      const cur = snap?.concurrentViewers ?? null;
      let alert = null;

      if (snap?.actualEndTime) {
        alert = 'stream ended';
      } else if (prev?.concurrentViewers != null && cur == null && !snap?.actualEndTime) {
        alert = 'concurrentViewers missing (hidden or ingest issue?)';
      } else {
        alert = checkDrop(label, prev?.concurrentViewers, cur);
      }

      // When concurrent is hidden, stall in viewCount growth can indicate a dead stream.
      if (!alert && cur == null && snap?.viewCount != null && prev?.viewCount != null) {
        const stalled = snap.viewCount === prev.viewCount;
        const stallCount = (prev.stallCount || 0) + (stalled ? 1 : 0);
        if (stallCount >= 3) alert = `viewCount stalled at ${snap.viewCount} (3 ticks)`;
        last.set(key, {
          concurrentViewers: cur,
          viewCount: snap.viewCount,
          stallCount: stalled ? stallCount : 0,
        });
        const row = {
          ts: new Date().toISOString(),
          label,
          broadcastId,
          concurrentViewers: cur,
          viewCount: snap.viewCount,
          alert,
          stallCount: stalled ? stallCount : 0,
        };
        log(row);
        continue;
      }

      const row = {
        ts: new Date().toISOString(),
        label,
        broadcastId,
        concurrentViewers: cur,
        viewCount: snap?.viewCount ?? null,
        alert,
      };
      log(row);
      last.set(key, {
        concurrentViewers: cur,
        viewCount: snap?.viewCount ?? null,
        stallCount: 0,
      });
    } catch (e) {
      log({
        ts: new Date().toISOString(),
        label,
        broadcastId,
        error: e.response?.data?.error?.message || e.message,
        alert: 'api_error',
      });
    }
  }
}

async function main() {
  console.log(`[concurrent] watching ${SIDECAR} every ${INTERVAL_MS / 1000}s — drop ≥${Math.round(DROP_PCT * 100)}% and ≥${DROP_MIN} viewers (base≥${MIN_BASE})`);
  await tick();
  setInterval(() => tick().catch((e) => console.error('[concurrent] tick failed:', e.message)), INTERVAL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
