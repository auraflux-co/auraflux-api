#!/usr/bin/env node
'use strict';
/**
 * YouTube Studio "Dual stream" cannot be toggled via the Data API — only in Studio UI.
 * This script prints the exact steps and optionally syncs LIVE_GRID_YOUTUBE_DUAL_STREAM=off to Render.
 */
const path = require('path');

const channelId = process.env.YOUTUBE_CHANNEL_ID || 'UCQkyOwPOv3iL8Ew2yQKbd9g';
const broadcastId = process.env.LIVE_GRID_BROADCAST_ID || 'Vab6umtRFyk';

console.log(`
YouTube Dual stream — turn OFF in Studio (required once per stream key, before GO LIVE)

1. Open: https://studio.youtube.com/channel/${channelId}/livestreaming
2. Click **Stream** (left) — not Webcam
3. Under **Stream settings**, find **Dual stream**
4. Toggle **OFF** (must be off before you start streaming — cannot remove mid-stream)
5. Confirm horizontal stream key is your RTMP key (not "Auto" vertical crop)

Listing: https://youtube.com/live/${broadcastId}

After Dual stream is OFF:
- YouTube CDN delivers 16:9 landscape (not 1080×1080 square)
- Render profile uses 1920×1080 encode (LIVE_GRID_YOUTUBE_DUAL_STREAM=off)

Our legacy LIVE_GRID_DUAL_BROADCAST (second YT listing + ffmpeg 9:16) stays OFF — separate feature.
`);

if (process.argv.includes('--sync-render')) {
  process.env.LIVE_GRID_YOUTUBE_DUAL_STREAM = 'off';
  process.env.LIVE_GRID_DUAL_BROADCAST = 'off';
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const serviceId = process.argv[process.argv.indexOf('--sync-render') + 1] || 'srv-d8qs41ernols73ej7720';
  require('./sync_broadcast_env_to_render.js');
  console.log(`\n[done] synced dual-stream=off to ${serviceId} — redeploy broadcast sidecar to apply`);
}
