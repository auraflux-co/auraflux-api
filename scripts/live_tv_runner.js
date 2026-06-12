#!/usr/bin/env node
/**
 * ClipzWorld TV — standalone runner (CPD-957)
 *
 * Runs the loop channel without the C0 server, for when the server can't be
 * restarted (e.g. the Live Grid is broadcasting). Once the server restarts,
 * stop this and use the /live-tv endpoints instead — never run both.
 *
 *   node scripts/live_tv_runner.js [--shuffle]
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
