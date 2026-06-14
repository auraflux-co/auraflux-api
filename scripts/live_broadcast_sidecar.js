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
const { registerLiveBroadcastRoutes } = require('../lib/broadcast/live_routes');

const PORT = Number(process.env.LIVE_SIDECAR_PORT || 3001);
const liveState = { grid: null, tv: null };

const app = express();
app.use(express.json({ limit: '2mb' }));
registerLiveBroadcastRoutes(app, liveState);

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[broadcast-sidecar] listening on http://127.0.0.1:${PORT} (pid ${process.pid})`);
  console.log('[broadcast-sidecar] ClipzWorld TV + Live Grid ffmpeg live here — safe to restart auraflux');
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

setInterval(() => {
  const tv = liveState.tv?.status?.();
  const grid = liveState.grid?.running;
  if (tv?.running || grid) {
    console.log(`[broadcast-sidecar] heartbeat tv=${!!tv?.running} grid=${!!grid} tvUp=${tv?.uptimeSec || 0}s`);
  }
}, 5 * 60 * 1000);
