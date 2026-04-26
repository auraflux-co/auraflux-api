#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: '.env' });
const axios = require('axios');

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getOpt = (name, def) => {
  const hit = args.find(a => a.startsWith(`${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};

const confirm = hasFlag('--confirm');
const dryRun = hasFlag('--dry-run');
const maxPasses = Math.max(1, Math.min(500, Number(getOpt('--max-passes', '100')) || 100));
const perPassLimit = Math.max(1, Math.min(100, Number(getOpt('--limit', '100')) || 100));

if (!confirm) {
  console.error('Refusing to run without --confirm.');
  console.error('Usage: node scripts/heygen_delete_all.cjs --confirm [--dry-run] [--max-passes=100] [--limit=100]');
  process.exit(1);
}

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;
if (!HEYGEN_API_KEY) {
  console.error('HEYGEN_API_KEY not set.');
  process.exit(1);
}

async function listVideos() {
  const resp = await axios.get(
    `https://api.heygen.com/v1/video.list?limit=${perPassLimit}`,
    { headers: { 'X-Api-Key': HEYGEN_API_KEY }, timeout: 30000 }
  );
  return resp.data?.data?.videos || [];
}

async function deleteOne(video) {
  const headers = { 'X-Api-Key': HEYGEN_API_KEY, 'Content-Type': 'application/json' };
  const attempts = [
    () => axios.post('https://api.heygen.com/v1/video.delete', { video_id: video.video_id }, { headers, timeout: 30000 }),
    () => axios.post(
      'https://api.heygen.com/v1/video.delete',
      { video_id: video.video_id, type: video.type || 'GENERATED' },
      { headers, timeout: 30000 }
    ),
    () => axios.delete(`https://api.heygen.com/v3/videos/${video.video_id}`, {
      headers: { 'X-Api-Key': HEYGEN_API_KEY },
      timeout: 30000
    })
  ];

  let lastErr = null;
  for (const run of attempts) {
    try {
      await run();
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

(async () => {
  let totalDeleted = 0;
  let totalSeen = 0;
  const failures = [];

  for (let pass = 1; pass <= maxPasses; pass++) {
    const videos = await listVideos();
    if (!videos.length) break;
    totalSeen += videos.length;
    console.log(`[heygen-delete-all] pass ${pass}: fetched ${videos.length}`);

    if (dryRun) continue;
    for (const video of videos) {
      try {
        await deleteOne(video);
        totalDeleted++;
        if (totalDeleted % 20 === 0) console.log(`[heygen-delete-all] deleted ${totalDeleted}`);
      } catch (err) {
        failures.push({
          video_id: video.video_id,
          title: video.video_title || null,
          error: err.response?.data || err.message || 'unknown_error'
        });
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }

  const remaining = (await listVideos()).length;
  const out = {
    dryRun,
    totalSeen,
    totalDeleted,
    failedCount: failures.length,
    remaining,
    sampleFailures: failures.slice(0, 20)
  };
  console.log(JSON.stringify(out, null, 2));
  if (failures.length > 0) process.exitCode = 2;
})().catch((err) => {
  console.error(err.response?.data || err.message || err);
  process.exit(1);
});

