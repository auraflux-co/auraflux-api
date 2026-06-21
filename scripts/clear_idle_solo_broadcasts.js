#!/usr/bin/env node
'use strict';
/**
 * End pre-provisioned solo broadcasts that never went live (Studio "Upcoming" clutter).
 * Clears LIVE_GRID_SOLO_N_BROADCAST_ID + WATCH_URL on Render — keeps stream/RTMP key.
 *
 * Usage:
 *   node scripts/clear_idle_solo_broadcasts.js [--fleet=a|b] [render-service-id]
 *   node scripts/clear_idle_solo_broadcasts.js --slot=5 --fleet=a
 */
const axios = require('axios');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SERVICE_A = 'srv-d8qs41ernols73ej7720';
const SERVICE_B = 'srv-d8rvm1sm0tmc739qq620';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const slotArg = argv.find((a) => a.startsWith('--slot='));
const onlySlot = slotArg ? Number(slotArg.split('=')[1]) : null;
const fleetArg = argv.find((a) => a.startsWith('--fleet='));
const SERVICE_ID = argv.find((a) => a.startsWith('srv-'))
  || (fleetArg?.split('=')[1] === 'b' ? SERVICE_B : SERVICE_A);

const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.error('RENDER_API_KEY required');
  process.exit(1);
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
    console.log(`[dry-run] would clear ${key}`);
    return;
  }
  if (value === '' || value == null) {
    await axios.delete(
      `https://api.render.com/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    ).catch(() => putRenderEnvValue(serviceId, key, 'pending'));
    return;
  }
  await putRenderEnvValue(serviceId, key, value);
}

async function putRenderEnvValue(serviceId, key, value) {
  await axios.put(
    `https://api.render.com/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
    { value: String(value) },
    { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } },
  );
}

async function main() {
  const fleetId = fleetArg?.split('=')[1] || (SERVICE_ID === SERVICE_B ? 'b' : 'a');
  const { localFleetSlots } = require('../lib/live_grid/solo_roster_fleet');
  const slots = localFleetSlots(fleetId).filter((s) => onlySlot == null || s.localPool === onlySlot);

  console.log(`[clear-idle-broadcast] service=${SERVICE_ID} fleet=${fleetId} slots=${slots.map((s) => s.slot).join(',')} dry=${DRY}`);

  const renderEnv = await fetchRenderEnv(SERVICE_ID);
  for (const k of [
    'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN',
    'YOUTUBE_BACKUP_CLIENT_ID', 'YOUTUBE_BACKUP_CLIENT_SECRET', 'YOUTUBE_BACKUP_REFRESH_TOKEN',
  ]) {
    if (renderEnv[k]) process.env[k] = renderEnv[k];
  }

  const yt = require('../lib/services/youtube_direct');
  if (!yt.isConnected()) {
    console.error('YouTube not connected on this service');
    process.exit(1);
  }

  for (const slotDef of slots) {
    const i = slotDef.localPool;
    const bid = renderEnv[`LIVE_GRID_SOLO_${i}_BROADCAST_ID`];
    if (!bid) {
      console.log(`[clear-idle-broadcast] slot ${slotDef.slot} @${slotDef.login} — no broadcast id`);
      continue;
    }

    let status = null;
    try {
      status = await yt.getBroadcastStatus(bid);
    } catch (e) {
      console.warn(`[clear-idle-broadcast] slot ${slotDef.slot} status check failed: ${e.message}`);
    }

    if (status?.lifeCycleStatus === 'live' || status?.lifeCycleStatus === 'testing') {
      console.log(`[clear-idle-broadcast] slot ${slotDef.slot} SKIP — ${status.lifeCycleStatus}`);
      continue;
    }

    console.log(`[clear-idle-broadcast] slot ${slotDef.slot} @${slotDef.login} ending ${bid} (${status?.lifeCycleStatus || 'unknown'})`);
    if (!DRY) {
      try {
        await yt.cancelLiveBroadcast(bid);
      } catch (e) {
        console.warn(`[clear-idle-broadcast] endLiveBroadcast: ${e.message}`);
      }
      await putRenderEnv(SERVICE_ID, `LIVE_GRID_SOLO_${i}_BROADCAST_ID`, '');
      await putRenderEnv(SERVICE_ID, `LIVE_GRID_SOLO_${i}_WATCH_URL`, '');
    }
  }

  console.log('[clear-idle-broadcast] done — Studio Upcoming should clear after refresh; broadcast created on next go-live');
}

main().catch((e) => {
  console.error('[clear-idle-broadcast]', e.response?.data || e.message);
  process.exit(1);
});
