#!/usr/bin/env node
/**
 * ClipzWorld TV — standalone runner (CPD-957) — LEGACY
 *
 * Prefer pm2 process `broadcast-sidecar` (scripts/live_broadcast_sidecar.js).
 * It survives auraflux restarts during code deploys. This runner is only for
 * emergencies when the sidecar is down.
 *
 *   node scripts/live_tv_runner.js [--shuffle]
 *
 * Never run this AND broadcast-sidecar at the same time.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { LiveTvManager } = require('../lib/live_tv/manager');

const m = new LiveTvManager();
m.start({ shuffle: process.argv.includes('--shuffle') });

setInterval(() => {
  const s = m.status();
  console.log(`[live-tv] heartbeat — ${s.nowPlaying} (${s.position}, loop ${s.loop + 1}, up ${Math.floor(s.uptimeSec / 60)}m)`);
}, 5 * 60_000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { m.stop(); process.exit(0); });
}
