#!/usr/bin/env node
'use strict';

/**
 * CPD-1029 — YouTube Studio native dual-format workflow.
 * Dual stream cannot be toggled while RTMP is active; sidecar holds encoder until rtmp-go.
 *
 * Usage:
 *   node scripts/youtube_studio_dual_stream.js [render-service-id]
 */

const fs = require('fs');
const path = require('path');

const PROFILE = path.join(__dirname, '..', 'config', 'live_grid_profile_render.json');

const WORKFLOW = `
YouTube Studio native dual-format (CPD-1029)
============================================

1. GO LIVE from Broadcast Control — grid starts but RTMP is HELD (no ingest yet).
2. Open YouTube Studio → Stream → Stream settings.
3. Enable Dual stream → Vertical format: Auto.
4. Save, then start RTMP:
     curl -X POST https://auraflux-broadcast-staging.onrender.com/live-grid/rtmp-go

Why Dual stream was greyed out:
- Our sidecar used to push RTMP immediately (and auto-resume on reboot).
- YouTube locks Dual stream settings while the encoder is connected.

Fix on Render:
- LIVE_GRID_STUDIO_DUAL_FIRST=on  (hold RTMP until Studio configured)
- LIVE_GRID_YOUTUBE_DUAL_STREAM=on (landscape 1920×1080 ingest for Auto vertical)
- LIVE_GRID_AUTO_RESUME=off       (reboot must not reconnect RTMP before you configure Studio)

Skip hold (emergency): POST /live-grid/start with { "rtmpGo": true }
`;

function main() {
  console.log(WORKFLOW.trim());
  const svcId = process.argv[2];
  if (!svcId) return;

  const profile = JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
  const keys = [
    'LIVE_GRID_YOUTUBE_DUAL_STREAM',
    'LIVE_GRID_STUDIO_DUAL_FIRST',
    'LIVE_GRID_AUTO_RESUME',
  ];
  console.log(`\nSync profile keys to Render service ${svcId}:`);
  for (const key of keys) {
    console.log(`  ${key}=${profile.env[key]}`);
  }
  console.log('\nRun: node scripts/sync_broadcast_env_to_render.js', svcId);
}

main();
