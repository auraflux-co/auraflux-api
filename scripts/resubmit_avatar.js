#!/usr/bin/env node
'use strict';
/**
 * Re-submit avatar renders for a Gate-1-approved job (EchoMimic or HeyGen).
 * Resumes from per-scene checkpoints in card.heygen.videoJobs when present.
 *
 * Usage:
 *   node scripts/resubmit_avatar.js                          # default long twitch job
 *   node scripts/resubmit_avatar.js script_twitch_1781375085847
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');

const jobId = process.argv[2] || 'script_twitch_1781375085847';
const base = process.env.CWN_SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;

(async () => {
  console.log(`[resubmit] POST ${base}/job/${jobId}/resubmit-avatar`);
  const resp = await axios.post(`${base}/job/${jobId}/resubmit-avatar`, {}, { timeout: 15000 });
  console.log(JSON.stringify(resp.data, null, 2));
  if (resp.data.resume) {
    console.log(`[resubmit] resuming — ${resp.data.completedScenes} scene(s) already on checkpoint`);
  }
  console.log(`[resubmit] tail: pm2 logs auraflux --lines 50`);
})().catch((e) => {
  console.error(`[resubmit] ❌ ${e.response?.data?.error || e.message}`);
  process.exit(1);
});
