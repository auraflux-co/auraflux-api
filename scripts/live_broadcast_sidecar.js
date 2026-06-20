#!/usr/bin/env node
/**
 * Broadcast sidecar — owns ClipzWorld TV + Live Grid ffmpeg processes.
 * Render: auraflux-broadcast-staging (production encode + delivery QA + self-heal).
 * Local Mac: optional dev only — not required for live grid on Render.
 *
 *   pm2 start ecosystem.config.js --only broadcast-sidecar
 *   curl http://127.0.0.1:3001/live-broadcast/health
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

if (process.env.RENDER || process.env.NODE_ENV === 'staging') {
  try {
    const { applyRenderProfile } = require('../lib/live_grid/render_profile');
    applyRenderProfile((m) => console.log(`[broadcast-sidecar] ${m}`));
  } catch (e) {
    console.warn(`[broadcast-sidecar] render profile skipped: ${e.message}`);
  }
}

const express = require('express');
const { registerLiveBroadcastRoutes, autoResumeLiveGrid } = require('../lib/broadcast/live_routes');

const PORT = Number(process.env.PORT || process.env.LIVE_SIDECAR_PORT || 3001);
const HOST = process.env.LIVE_SIDECAR_BIND
  || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const liveState = { grid: null, tv: null };

const app = express();
app.use(express.json({ limit: '2mb' }));
registerLiveBroadcastRoutes(app, liveState);

const server = app.listen(PORT, HOST, () => {
  console.log(`[broadcast-sidecar] listening on http://${HOST}:${PORT} (pid ${process.pid})`);
  console.log('[broadcast-sidecar] ClipzWorld TV + Live Grid ffmpeg live here — safe to restart auraflux');
  autoResumeLiveGrid(liveState)
    .then((r) => {
      if (r.resumed) console.log(`[broadcast-sidecar] auto-resume ok → ${r.watchUrl || 'RTMP'}`);
      else if (r.reason !== 'no_state' && r.reason !== 'disabled') {
        console.log(`[broadcast-sidecar] auto-resume skipped: ${r.reason}${r.error ? ` (${r.error})` : ''}`);
      }
    })
    .catch((e) => console.warn(`[broadcast-sidecar] auto-resume error: ${e.message}`));
});

async function shutdown() {
  console.log('[broadcast-sidecar] shutting down — stopping streams…');
  try { liveState.tv?.stop(); } catch (_) {}
  try { await liveState.grid?.stop(); } catch (_) {}
  server.close(() => process.exit(0));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown().catch(() => process.exit(1)));
}

setInterval(async () => {
  const tv = liveState.tv?.status?.();
  const grid = liveState.grid;
  const gridLive = !!grid?.running;
  if (tv?.running || gridLive) {
    console.log(`[broadcast-sidecar] heartbeat tv=${!!tv?.running} grid=${gridLive} tvUp=${tv?.uptimeSec || 0}s`);
  }
  if (!gridLive) return;
  try {
    grid.autoTuneEncodeIfNeeded?.();
    const heal = await grid.autoHealDelivery?.();
    if (heal?.action && heal.action !== 'none') {
      console.log(`[broadcast-sidecar] delivery heal action=${heal.action} ok=${heal.ok}`);
    }
    const qa = heal?.qa || grid.buildDeliveryQa?.();
    if (qa?.viewerLevel === 'bad') {
      console.warn(`[broadcast-sidecar] delivery BAD score=${qa.viewerScore} seeing=${(qa.seeing || []).join('; ')}`);
    }
  } catch (e) {
    console.warn(`[broadcast-sidecar] heartbeat delivery check failed: ${e.message}`);
  }
}, Number(process.env.LIVE_SIDECAR_HEARTBEAT_MS || 30000));
