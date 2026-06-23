#!/usr/bin/env node
/**
 * Broadcast sidecar — owns ClipzWorld TV + Live Grid ffmpeg processes.
 * Survives `pm2 restart auraflux` (code deploys) so Twitch/YouTube stay live.
 *
 *   pm2 start ecosystem.config.js --only broadcast-sidecar
 *   curl http://127.0.0.1:3001/live-broadcast/health
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const express = require('express');
const { registerLiveBroadcastRoutes, autoResumeLiveGrid } = require('../lib/broadcast/live_routes');

const PORT = Number(process.env.LIVE_SIDECAR_PORT || 3001);
const liveState = { grid: null, tv: null };

const app = express();
app.use(express.json({ limit: '2mb' }));
registerLiveBroadcastRoutes(app, liveState);

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[broadcast-sidecar] listening on http://127.0.0.1:${PORT} (pid ${process.pid})`);
  console.log('[broadcast-sidecar] ClipzWorld TV + Live Grid ffmpeg live here — safe to restart auraflux');
  setTimeout(() => {
    autoResumeLiveGrid(liveState).catch((e) => {
      console.warn(`[broadcast-sidecar] auto-resume error: ${e.message}`);
    });
  }, 2500);
});

async function shutdown() {
  console.log('[broadcast-sidecar] shutting down — stopping streams…');
  try { liveState.tv?.stop(); } catch (_) {}
  const rtmpBypass = !!(
    (process.env.LIVE_GRID_RTMP_URL || process.env.YOUTUBE_LIVE_RTMP_URL) &&
    (process.env.LIVE_GRID_BROADCAST_ID || process.env.LIVE_GRID_WATCH_URL)
  );
  try {
    if (liveState.grid?.running) {
      const { saveResumeFromManager } = require('../lib/live_grid/resume_state');
      saveResumeFromManager(liveState.grid);
    }
    await liveState.grid?.stop({ skipEndBroadcast: rtmpBypass });
  } catch (_) {}
  server.close(() => process.exit(0));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown().catch(() => process.exit(1)));
}

// ffmpeg pipe closes during encoder restart — must not kill the sidecar mid GO LIVE
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') {
    console.warn('[broadcast-sidecar] ignored EPIPE (ffmpeg pipe closed during encode)');
    return;
  }
  console.error('[broadcast-sidecar] uncaughtException:', err);
  process.exit(1);
});

setInterval(() => {
  const tv = liveState.tv?.status?.();
  const grid = liveState.grid?.running;
  if (tv?.running || grid) {
    console.log(`[broadcast-sidecar] heartbeat tv=${!!tv?.running} grid=${!!grid} tvUp=${tv?.uptimeSec || 0}s`);
  }
  if (grid && liveState.grid) {
    try {
      const { saveResumeFromManager } = require('../lib/live_grid/resume_state');
      saveResumeFromManager(liveState.grid);
    } catch (_) {}
  }
  if (grid && liveState.grid?.autoTuneEncodeIfNeeded) {
    try {
      const tune = liveState.grid.autoTuneEncodeIfNeeded();
      if (tune?.action === 'downshifted') {
        console.log(`[broadcast-sidecar] encode autotune → ${tune.encode?.fps}fps ${tune.encode?.bitrateK}k (load ${tune.loadPerCore}/core)`);
      }
    } catch (e) {
      console.warn(`[broadcast-sidecar] encode autotune failed: ${e.message}`);
    }
  }
}, 60 * 1000);
