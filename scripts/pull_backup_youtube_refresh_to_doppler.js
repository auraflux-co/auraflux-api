#!/usr/bin/env node
'use strict';
/** Copy YOUTUBE_BACKUP_REFRESH_TOKEN from broadcast-staging Render → Doppler prd. */
require('dotenv').config();
const axios = require('axios');
const { execSync } = require('child_process');

const serviceId = process.argv[2] || 'srv-d8qs41ernols73ej7720';
const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.error('RENDER_API_KEY required');
  process.exit(1);
}

(async () => {
  let cursor = null;
  let refresh = '';
  do {
    const url = `https://api.render.com/v1/services/${serviceId}/env-vars?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    for (const row of data) {
      const k = row.envVar?.key;
      if (k === 'YOUTUBE_BACKUP_REFRESH_TOKEN') refresh = row.envVar.value || '';
      cursor = row.cursor;
    }
    if (!cursor || data.length < 100) break;
  } while (cursor);
  if (!refresh) {
    console.error('YOUTUBE_BACKUP_REFRESH_TOKEN not on Render — visit /connect/youtube/backup first');
    process.exit(1);
  }
  if (!process.env.DOPPLER_TOKEN) {
    console.error('DOPPLER_TOKEN required in .env');
    process.exit(1);
  }
  execSync(
    `doppler secrets set YOUTUBE_BACKUP_REFRESH_TOKEN="${refresh.replace(/"/g, '\\"')}" --project auraflux --config prd --silent`,
    { stdio: 'inherit', env: process.env },
  );
  console.log('Doppler prd updated with YOUTUBE_BACKUP_REFRESH_TOKEN');
})();
