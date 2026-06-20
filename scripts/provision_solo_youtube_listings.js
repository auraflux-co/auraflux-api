#!/usr/bin/env node
'use strict';
/**
 * CPD-1047 — Create four YouTube solo listings (Q1–Q4) and push LIVE_GRID_SOLO_* to Render.
 * YouTube OAuth creds are read from auraflux-broadcast-staging env (not c0).
 *
 * Usage:
 *   node scripts/provision_solo_youtube_listings.js [--dry-run] [render-service-id]
 */
const axios = require('axios');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SERVICE_ID = process.argv.find((a) => a.startsWith('srv-')) || 'srv-d8qs41ernols73ej7720';
const DRY = process.argv.includes('--dry-run');
const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.error('RENDER_API_KEY required in cwn-production .env');
  process.exit(1);
}

const LABELS = ['Screen 1', 'Screen 2', 'Screen 3', 'Screen 4'];

async function fetchRenderEnv(serviceId) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const out = {};
  let cursor = '';
  for (;;) {
    const url = new URL(`https://api.render.com/v1/services/${serviceId}/env-vars`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    const { data } = await axios.get(url.toString(), { headers });
    for (const row of data || []) {
      const key = row.envVar?.key || row.key;
      const value = row.envVar?.value || row.value;
      if (key) out[key] = value;
    }
    cursor = data?.length ? data[data.length - 1]?.cursor : '';
    if (!cursor) break;
  }
  return out;
}

async function putRenderEnv(serviceId, key, value) {
  if (DRY) {
    console.log(`[dry-run] would set ${key}`);
    return;
  }
  await axios.put(
    `https://api.render.com/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
    { value: String(value) },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
  );
}

async function main() {
  console.log(`[solo-provision] service=${SERVICE_ID} dry=${DRY}`);
  const renderEnv = await fetchRenderEnv(SERVICE_ID);
  for (const k of ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN']) {
    if (renderEnv[k]) process.env[k] = renderEnv[k];
  }
  if (!process.env.YOUTUBE_REFRESH_TOKEN) {
    console.error('[solo-provision] YOUTUBE_REFRESH_TOKEN missing on Render broadcast service');
    process.exit(1);
  }

  const { createLiveStream, createLiveBroadcast } = require('../lib/services/youtube_direct');
  const updates = {};
  for (let i = 1; i <= 4; i++) {
    const existing = renderEnv[`LIVE_GRID_SOLO_${i}_RTMP_URL`];
    if (existing) {
      console.log(`[solo-provision] Q${i} already configured — skip create`);
      continue;
    }
    const label = LABELS[i - 1];
    console.log(`[solo-provision] creating Q${i} (${label})…`);
    if (DRY) continue;
    const stream = await createLiveStream({
      title: `ClipzWorld Live Grid — ${label} ingest`,
      resolution: '1080p',
      frameRate: '30fps',
    });
    const broadcast = await createLiveBroadcast({
      title: `ClipzWorld Live Grid — ${label}`,
      description: 'Solo seat stream — synced with main 2×2 grid (CPD-1047).',
      privacyStatus: 'public',
      streamId: stream.streamId,
    });
    updates[`LIVE_GRID_SOLO_${i}_BROADCAST_ID`] = broadcast.broadcastId;
    updates[`LIVE_GRID_SOLO_${i}_WATCH_URL`] = broadcast.watchUrl;
    updates[`LIVE_GRID_SOLO_${i}_STREAM_ID`] = stream.streamId;
    updates[`LIVE_GRID_SOLO_${i}_RTMP_URL`] = stream.rtmpUrl;
    updates[`LIVE_GRID_SOLO_${i}_LABEL`] = label;
    console.log(`[solo-provision] Q${i} broadcastId=${broadcast.broadcastId}`);
  }

  if (!Object.keys(updates).length) {
    console.log('[solo-provision] nothing new to push');
    return;
  }

  for (const [key, value] of Object.entries(updates)) {
    await putRenderEnv(SERVICE_ID, key, value);
  }
  console.log(`[solo-provision] pushed ${Object.keys(updates).length} env keys — redeploy broadcast-staging to load`);
}

main().catch((e) => {
  console.error('[solo-provision]', e.response?.data || e.message);
  process.exit(1);
});
