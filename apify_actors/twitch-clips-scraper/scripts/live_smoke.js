'use strict';
/**
 * live_smoke.js — hits the real Twitch GQL endpoint. Run manually:
 *   node scripts/live_smoke.js [streamer] [period] [sort]
 */
const { fetchStreamerClips } = require('../src/twitch_gql');

(async () => {
  const streamer = process.argv[2] || 'caseoh_';
  const period = process.argv[3] || '7d';
  const sort = process.argv[4] || 'views';
  const res = await fetchStreamerClips(streamer, { period, sort, limit: 10, minDurationSeconds: 5 });
  if (!res.found) {
    console.error(`NOT FOUND: ${res.streamer} — ${res.error}`);
    process.exit(1);
  }
  console.log(`${res.streamer} — ${res.clips.length} clips (${period}, ${sort})`);
  for (const c of res.clips) {
    console.log(`  ${String(c.viewCount).padStart(8)} views | ${c.durationSeconds}s | ${c.game || '?'} | ${c.title.slice(0, 50)}`);
  }
  console.log('\nSample item:');
  console.log(JSON.stringify(res.clips[0], null, 2));
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
