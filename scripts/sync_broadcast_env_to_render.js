#!/usr/bin/env node
'use strict';
/** Push Live Grid env from c0 + Render profile to broadcast service (CPD-1042 / CPD-1043). */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const serviceId = process.argv[2];
if (!serviceId) {
  console.error('usage: node scripts/sync_broadcast_env_to_render.js <render-service-id>');
  process.exit(1);
}

const apiKey = process.env.RENDER_API_KEY;
if (!apiKey) {
  console.error('RENDER_API_KEY required');
  process.exit(1);
}

const c0Root = process.env.C0_ROOT || path.join(process.env.HOME, 'cwn-c0');
require('dotenv').config({ path: path.join(c0Root, '.env') });

const profilePath = path.join(__dirname, '..', 'config', 'live_grid_profile_render.json');
let profileEnv = {};
try {
  profileEnv = JSON.parse(fs.readFileSync(profilePath, 'utf8')).env || {};
  console.log(`[sync] loaded ${Object.keys(profileEnv).length} vars from ${path.basename(profilePath)}`);
} catch (e) {
  console.warn(`[sync] profile missing — using hardcoded fallbacks (${e.message})`);
}

const tokenPath = path.join(c0Root, 'data', 'youtube_tokens.json');
let ytRefresh = '';
if (fs.existsSync(tokenPath)) {
  try {
    ytRefresh = JSON.parse(fs.readFileSync(tokenPath, 'utf8')).refresh_token || '';
  } catch { /* ignore */ }
}
if (!ytRefresh) {
  ytRefresh = process.env.YOUTUBE_REFRESH_TOKEN || '';
}
if (!ytRefresh) {
  console.error('No YouTube refresh token in env or youtube_tokens.json');
  process.exit(1);
}

let twitchUserTokenJson = '';
const twitchTokenPath = path.join(c0Root, 'data', 'twitch_user_token.json');
if (fs.existsSync(twitchTokenPath)) {
  try {
    twitchUserTokenJson = fs.readFileSync(twitchTokenPath, 'utf8');
  } catch { /* ignore */ }
}

const env = {
  NODE_ENV: 'staging',
  PORT: '10000',
  LIVE_SIDECAR_PORT: '10000',
  LIVE_SIDECAR_BIND: '0.0.0.0',
  LIVE_BROADCAST_SIDECAR: 'on',
  ...profileEnv,
  LIVE_GRID_TWITCH_QUALITY: process.env.C0_TWITCH_QUALITY_FOR_RENDER
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
  LIVE_GRID_RTMP_URL: process.env.LIVE_GRID_RTMP_URL,
  LIVE_GRID_STREAM_ID: process.env.LIVE_GRID_STREAM_ID,
  LIVE_GRID_BROADCAST_ID: process.env.LIVE_GRID_BROADCAST_ID,
  LIVE_GRID_WATCH_URL: process.env.LIVE_GRID_WATCH_URL,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  LIVE_GRID_OPERATOR_MODE: process.env.LIVE_GRID_OPERATOR_MODE || 'off',
  LIVE_GRID_ALLOW_NEW_STREAM: process.env.LIVE_GRID_ALLOW_NEW_STREAM || 'off',
};

const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

(async () => {
  let added = 0;
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    await axios.put(`https://api.render.com/v1/services/${serviceId}/env-vars/${encodeURIComponent(key)}`, {
      value: String(value),
    }, { headers });
    added++;
  }
  console.log(`[sync] ${added} env vars set on ${serviceId}`);
})().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
