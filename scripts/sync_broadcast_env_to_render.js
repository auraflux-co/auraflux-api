#!/usr/bin/env node
'use strict';
/**
 * Push Live Grid env to auraflux-broadcast-staging on Render (CPD-1042 / CPD-1055).
 *
 * Uses ONE bulk PUT (merge with existing vars) — never per-key PUT loops (rate limits).
 *
 * Sources (no c0 dependency):
 *   1. config/live_grid_profile_render.json — encode defaults
 *   2. process.env — run via `bash scripts/doppler_run.sh node scripts/sync_broadcast_env_to_render.js <service-id>`
 *
 * Usage:
 *   bash scripts/doppler_run.sh node scripts/sync_broadcast_env_to_render.js srv-d8qs41ernols73ej7720 a
 *   bash scripts/doppler_run.sh node scripts/sync_broadcast_env_to_render.js srv-d8rvm1sm0tmc739qq620 b
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const serviceId = process.argv[2];
const fleetArg = process.argv[3];
if (!serviceId) {
  console.error('usage: node scripts/sync_broadcast_env_to_render.js <render-service-id> [fleet-id a|b]');
  process.exit(1);
}

const FLEET_BY_SERVICE = {
  'srv-d8qs41ernols73ej7720': 'a',
  'srv-d8rvm1sm0tmc739qq620': 'b',
};
const fleetId = (fleetArg || FLEET_BY_SERVICE[serviceId] || 'a').toLowerCase();
const fleetPublicBase = fleetId === 'b'
  ? 'https://auraflux-broadcast-staging-b.onrender.com'
  : 'https://auraflux-broadcast-staging.onrender.com';
const fleetSlots = fleetId === 'b' ? '6-10' : '1-5';

const repoRoot = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(repoRoot, '.env') });

const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.error('RENDER_API_KEY required (cwn-production .env or doppler_run.sh)');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimited(err) {
  const status = err.response?.status;
  const msg = JSON.stringify(err.response?.data || err.message || '').toLowerCase();
  return status === 429 || msg.includes('rate limit');
}

async function withRetry(label, fn, { maxAttempts = 8 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimited(err) || attempt === maxAttempts) throw err;
      const waitMs = Math.min(90000, 1500 * (2 ** (attempt - 1)));
      console.warn(`[sync] ${label} rate limited — retry in ${waitMs}ms (${attempt}/${maxAttempts})`);
      await sleep(waitMs);
    }
  }
}

/** GET all env vars (paginated). Render wraps each row as { envVar: { key, value } }. */
async function fetchAllEnvVars(sid) {
  const map = new Map();
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const url = `https://api.render.com/v1/services/${sid}/env-vars?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { data } = await withRetry('GET env-vars', () => axios.get(url, { headers }));
    const items = Array.isArray(data) ? data : [];
    if (!items.length) break;
    for (const item of items) {
      const ev = item.envVar || item;
      if (ev?.key != null) map.set(ev.key, String(ev.value ?? ''));
    }
    const last = items[items.length - 1];
    cursor = last?.cursor || '';
    if (items.length < 100 || !cursor) break;
  }
  return map;
}

/** PUT full merged list — Render replaces entire set; caller must include all existing keys. */
async function putAllEnvVars(sid, rows) {
  const body = rows.map(({ key, value }) => ({ key, value: String(value) }));
  const { data } = await withRetry('PUT env-vars', () => axios.put(
    `https://api.render.com/v1/services/${sid}/env-vars`,
    body,
    { headers },
  ));
  return data;
}

const profilePath = path.join(repoRoot, 'config', 'live_grid_profile_render.json');
let profileEnv = {};
try {
  profileEnv = JSON.parse(fs.readFileSync(profilePath, 'utf8')).env || {};
  console.log(`[sync] loaded ${Object.keys(profileEnv).length} vars from ${path.basename(profilePath)}`);
} catch (e) {
  console.warn(`[sync] profile missing — using hardcoded fallbacks (${e.message})`);
}

const ytRefresh = process.env.YOUTUBE_REFRESH_TOKEN || '';
if (!ytRefresh) {
  console.error('YOUTUBE_REFRESH_TOKEN required — use doppler_run.sh or set in cwn-production .env');
  process.exit(1);
}

const twitchUserTokenJson = process.env.TWITCH_USER_TOKEN_JSON || '';

const desired = {
  NODE_ENV: 'staging',
  PORT: '10000',
  LIVE_SIDECAR_PORT: '10000',
  LIVE_SIDECAR_BIND: '0.0.0.0',
  LIVE_BROADCAST_SIDECAR: 'on',
  ...profileEnv,
  LIVE_GRID_TWITCH_QUALITY: process.env.LIVE_GRID_TWITCH_QUALITY
    || profileEnv.LIVE_GRID_TWITCH_QUALITY
    || '720p60,720p,best',
  LIVE_GRID_AUDIO_COPY: process.env.LIVE_GRID_AUDIO_COPY_RENDER || profileEnv.LIVE_GRID_AUDIO_COPY || 'off',
  LIVE_GRID_AUDIO_HZ: process.env.LIVE_GRID_AUDIO_HZ || profileEnv.LIVE_GRID_AUDIO_HZ || '48000',
  LIVE_GRID_SWAP_DEBOUNCE_MS: process.env.LIVE_GRID_SWAP_DEBOUNCE_MS || profileEnv.LIVE_GRID_SWAP_DEBOUNCE_MS || '8000',
  LIVE_GRID_SWAP_STABLE_MS: process.env.LIVE_GRID_SWAP_STABLE_MS || profileEnv.LIVE_GRID_SWAP_STABLE_MS || '3000',
  LIVE_GRID_RESTREAMER_HLS_WAIT_MS: process.env.LIVE_GRID_RESTREAMER_HLS_WAIT_MS || '45000',
  LIVE_GRID_RESTREAMER_HLS_LAG: process.env.LIVE_GRID_RESTREAMER_HLS_LAG || '3',
  LIVE_GRID_MUSIC_USE_BED: process.env.LIVE_GRID_MUSIC_USE_BED || 'on',
  LIVE_GRID_RELAY_FPS: process.env.LIVE_GRID_RELAY_FPS || '30',
  LIVE_GRID_UDP_MASTER_REFRESH_MS: process.env.LIVE_GRID_UDP_MASTER_REFRESH_MS || '0',
  LIVE_GRID_RELAY_SCALE_W: process.env.LIVE_GRID_RELAY_SCALE_W || '960',
  LIVE_GRID_RELAY_SCALE_H: process.env.LIVE_GRID_RELAY_SCALE_H || '540',
  LIVE_GRID_RELAY_BITRATE_K: process.env.LIVE_GRID_RELAY_BITRATE_K || '2200',
  LIVE_GRID_ENFORCE_LANDSCAPE: 'on',
  LIVE_GRID_YOUTUBE_SQUARE_PAD: 'off',
  LIVE_GRID_TRUST_ENV_BROADCAST: process.env.LIVE_GRID_TRUST_ENV_BROADCAST || 'on',
  LIVE_GRID_PROTECT_YT_RTMP: 'on',
  TWITCH_CLIENT_ID: process.env.TWITCH_CLIENT_ID,
  TWITCH_TOKEN: process.env.TWITCH_TOKEN,
  TWITCH_OAUTH_CLIENT_ID: process.env.TWITCH_OAUTH_CLIENT_ID,
  TWITCH_OAUTH_CLIENT_SECRET: process.env.TWITCH_OAUTH_CLIENT_SECRET,
  TWITCH_USER_TOKEN_JSON: twitchUserTokenJson,
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID,
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET,
  YOUTUBE_REFRESH_TOKEN: ytRefresh,
  YOUTUBE_BACKUP_CLIENT_ID: process.env.YOUTUBE_BACKUP_CLIENT_ID,
  YOUTUBE_BACKUP_CLIENT_SECRET: process.env.YOUTUBE_BACKUP_CLIENT_SECRET,
  YOUTUBE_BACKUP_REFRESH_TOKEN: process.env.YOUTUBE_BACKUP_REFRESH_TOKEN,
  BROADCAST_OPERATOR_SECRET: process.env.BROADCAST_OPERATOR_SECRET,
  BROADCAST_RENDER_SERVICE_ID: serviceId,
  PUBLIC_BASE_URL: fleetId === 'b'
    ? (process.env.PUBLIC_BASE_URL_B || fleetPublicBase)
    : (process.env.PUBLIC_BASE_URL || fleetPublicBase),
  RENDER: 'true',
  LIVE_GRID_KICK_INGEST: 'streamlink',
  LIVE_GRID_FLEET_ID: fleetId,
  LIVE_GRID_FLEET_SLOTS: fleetSlots,
  LIVE_GRID_PROGRAM_MODE: 'solo_roster',
  LIVE_GRID_FLEET_POOL_SIZE: '5',
  LIVE_GRID_FLEET_POLL_MS: profileEnv.LIVE_GRID_FLEET_POLL_MS || '45000',
  LIVE_GRID_SOLO_AUTO_START: 'off',
  LIVE_GRID_SOLO_STREAMER_LOCK: 'on',
  LIVE_GRID_RTMP_URL: process.env.LIVE_GRID_RTMP_URL,
  LIVE_GRID_STREAM_ID: process.env.LIVE_GRID_STREAM_ID,
  LIVE_GRID_BROADCAST_ID: process.env.LIVE_GRID_BROADCAST_ID,
  LIVE_GRID_WATCH_URL: process.env.LIVE_GRID_WATCH_URL,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  APIFY_API_TOKEN: process.env.APIFY_API_TOKEN,
  APIFY_PROXY_PASSWORD: process.env.APIFY_PROXY_PASSWORD,
  LIVE_GRID_KICK_PLAYBACK_REFRESH_MS: process.env.LIVE_GRID_KICK_PLAYBACK_REFRESH_MS || '300000',
  LIVE_GRID_KICK_HLS_TRANSCODE: process.env.LIVE_GRID_KICK_HLS_TRANSCODE || 'on',
  LIVE_GRID_KICK_HLS_W: process.env.LIVE_GRID_KICK_HLS_W || '1280',
  LIVE_GRID_KICK_HLS_H: process.env.LIVE_GRID_KICK_HLS_H || '720',
  LIVE_GRID_KICK_HLS_BITRATE_K: process.env.LIVE_GRID_KICK_HLS_BITRATE_K || '2500',
  LIVE_GRID_KICK_HLS_STALL_MS: process.env.LIVE_GRID_KICK_HLS_STALL_MS || '45000',
  LIVE_GRID_KICK_RELAY_TRANSCODE: process.env.LIVE_GRID_KICK_RELAY_TRANSCODE || 'on',
  LIVE_GRID_OPERATOR_MODE: process.env.LIVE_GRID_OPERATOR_MODE || 'off',
  LIVE_GRID_ALLOW_NEW_STREAM: process.env.LIVE_GRID_ALLOW_NEW_STREAM || 'off',
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('LIVE_GRID_SOLO_')),
  ),
};

(async () => {
  const existing = await fetchAllEnvVars(serviceId);
  console.log(`[sync] fetched ${existing.size} existing vars from Render`);

  let updated = 0;
  let added = 0;
  for (const [key, value] of Object.entries(desired)) {
    if (!value) continue;
    const next = String(value);
    if (!existing.has(key)) {
      existing.set(key, next);
      added++;
    } else if (existing.get(key) !== next) {
      existing.set(key, next);
      updated++;
    }
  }

  const merged = [...existing.entries()].map(([key, value]) => ({ key, value }));
  console.log(`[sync] merging ${added} new + ${updated} changed → ${merged.length} total (1 PUT)`);

  const result = await putAllEnvVars(serviceId, merged);
  const count = Array.isArray(result) ? result.length : merged.length;
  console.log(`[sync] ok — ${count} env vars on ${serviceId} (fleet ${fleetId}, source: cwn-production profile + env)`);
})().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
