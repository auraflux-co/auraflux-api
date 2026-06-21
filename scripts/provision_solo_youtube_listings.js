#!/usr/bin/env node
'use strict';
/**
 * CPD-1067 — Create YouTube solo listings (pool 1–5 per sidecar) and push LIVE_GRID_SOLO_* to Render.
 *
 * Usage:
 *   node scripts/provision_solo_youtube_listings.js [--dry-run] [--fleet=a|b] [render-service-id]
 */
const axios = require('axios');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SERVICE_A = 'srv-d8qs41ernols73ej7720';
const SERVICE_B = 'srv-d8rvm1sm0tmc739qq620';
const POOL_SIZE = 5;
const YT_API = 'https://www.googleapis.com/youtube/v3';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const fleetArg = argv.find((a) => a.startsWith('--fleet='));
const SERVICE_ID = argv.find((a) => a.startsWith('srv-'))
  || (fleetArg?.split('=')[1] === 'b' ? SERVICE_B : SERVICE_A);

const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.error('RENDER_API_KEY required in cwn-production .env');
  process.exit(1);
}

function fleetIdForService(serviceId) {
  return serviceId === SERVICE_B ? 'b' : 'a';
}

function fleetIdFromArg() {
  if (fleetArg) return fleetArg.split('=')[1].toLowerCase();
  return fleetIdForService(SERVICE_ID);
}

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
    console.log(`[dry-run] would set ${key}=${String(value).slice(0, 40)}…`);
    return;
  }
  await axios.put(
    `https://api.render.com/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
    { value: String(value) },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
  );
}

function slotKeys(i) {
  return {
    rtmp: `LIVE_GRID_SOLO_${i}_RTMP_URL`,
    stream: `LIVE_GRID_SOLO_${i}_STREAM_ID`,
    broadcast: `LIVE_GRID_SOLO_${i}_BROADCAST_ID`,
    watch: `LIVE_GRID_SOLO_${i}_WATCH_URL`,
    label: `LIVE_GRID_SOLO_${i}_LABEL`,
  };
}

function slotComplete(env, i) {
  const k = slotKeys(i);
  return !!(env[k.rtmp] && env[k.stream] && env[k.broadcast]);
}

async function fetchStreamRtmp(accessToken, streamId) {
  const res = await axios.get(`${YT_API}/liveStreams?part=cdn&id=${encodeURIComponent(streamId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ing = res.data.items?.[0]?.cdn?.ingestionInfo;
  if (!ing?.ingestionAddress || !ing?.streamName) return null;
  return { streamId, rtmpUrl: `${ing.ingestionAddress}/${ing.streamName}` };
}

async function fetchBroadcastStreamId(accessToken, broadcastId) {
  const res = await axios.get(`${YT_API}/liveBroadcasts?part=contentDetails&id=${encodeURIComponent(broadcastId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data.items?.[0]?.contentDetails?.boundStreamId || null;
}

function seoCopy(slotDef) {
  const login = slotDef.login;
  return {
    title: `ClipzWorld News — @${login} Live`,
    description: `Live mirror of @${login} on ClipzWorld News (slot ${slotDef.slot}).`,
    label: login,
  };
}

async function main() {
  const fleetId = fleetIdFromArg();
  const { localFleetSlots } = require('../lib/live_grid/solo_roster_fleet');
  const slots = localFleetSlots(fleetId);

  console.log(`[solo-provision] service=${SERVICE_ID} fleet=${fleetId} dry=${DRY}`);

  const renderEnv = await fetchRenderEnv(SERVICE_ID);
  const ytEnvKeys = [
    'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN',
    'YOUTUBE_BACKUP_CLIENT_ID', 'YOUTUBE_BACKUP_CLIENT_SECRET', 'YOUTUBE_BACKUP_REFRESH_TOKEN',
  ];
  for (const k of ytEnvKeys) {
    if (renderEnv[k]) process.env[k] = renderEnv[k];
  }
  const { hasBackupProfile } = require('../lib/services/youtube_api_profiles');
  console.log(`[solo-provision] backup OAuth ${hasBackupProfile() ? 'available (quota failover enabled)' : 'NOT configured on this service'}`);
  if (!process.env.YOUTUBE_REFRESH_TOKEN && !hasBackupProfile()) {
    console.error('[solo-provision] YOUTUBE_REFRESH_TOKEN missing on Render broadcast service');
    process.exit(1);
  }

  const { createLiveStream, createLiveBroadcast, getAccessToken } = require('../lib/services/youtube_direct');
  const accessToken = await getAccessToken();

  const updates = {};

  for (const slotDef of slots) {
    const i = slotDef.localPool;
    const k = slotKeys(i);
    const copy = seoCopy(slotDef);

    if (slotComplete(renderEnv, i)) {
      console.log(`[solo-provision] slot ${slotDef.slot} @${slotDef.login} complete — skip`);
      if (!renderEnv[k.label]) updates[k.label] = copy.label;
      continue;
    }

    let streamId = renderEnv[k.stream] || null;
    let rtmpUrl = renderEnv[k.rtmp] || null;
    let broadcastId = renderEnv[k.broadcast] || null;
    let watchUrl = renderEnv[k.watch] || null;

    console.log(`[solo-provision] slot ${slotDef.slot} @${slotDef.login} — repair/create (rtmp=${!!rtmpUrl} stream=${!!streamId} bid=${!!broadcastId})`);

    if (DRY) continue;

    if (streamId && !rtmpUrl && accessToken) {
      const fetched = await fetchStreamRtmp(accessToken, streamId);
      if (fetched) rtmpUrl = fetched.rtmpUrl;
    }

    if (broadcastId && !streamId && accessToken) {
      streamId = await fetchBroadcastStreamId(accessToken, broadcastId);
      if (streamId && !rtmpUrl) {
        const fetched = await fetchStreamRtmp(accessToken, streamId);
        if (fetched) rtmpUrl = fetched.rtmpUrl;
      }
    }

    if (!streamId || !rtmpUrl) {
      const stream = await createLiveStream({
        title: `${copy.title} ingest`,
        resolution: '1080p',
        frameRate: '30fps',
      });
      streamId = stream.streamId;
      rtmpUrl = stream.rtmpUrl;
      console.log(`[solo-provision] slot ${slotDef.slot} new stream ${streamId}`);
    }

    if (!broadcastId) {
      const broadcast = await createLiveBroadcast({
        title: copy.title,
        description: copy.description,
        privacyStatus: 'unlisted',
        streamId,
      });
      broadcastId = broadcast.broadcastId;
      watchUrl = broadcast.watchUrl;
      console.log(`[solo-provision] slot ${slotDef.slot} new broadcast ${broadcastId}`);
    }

    updates[k.rtmp] = rtmpUrl;
    updates[k.stream] = streamId;
    updates[k.broadcast] = broadcastId;
    updates[k.watch] = watchUrl || `https://youtube.com/live/${broadcastId}`;
    updates[k.label] = copy.label;
  }

  if (!Object.keys(updates).length) {
    console.log('[solo-provision] nothing new to push');
    return;
  }

  for (const [key, value] of Object.entries(updates)) {
    await putRenderEnv(SERVICE_ID, key, value);
  }
  console.log(`[solo-provision] pushed ${Object.keys(updates).length} env keys — redeploy sidecar to load`);
}

main().catch((e) => {
  console.error('[solo-provision]', e.response?.data || e.message);
  process.exit(1);
});
