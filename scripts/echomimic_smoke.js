#!/usr/bin/env node
'use strict';
/**
 * CPD-991 — EchoMimic end-to-end smoke test.
 *
 * Exercises the full production path through the adapter layer:
 *   ElevenLabs TTS → R2 upload → RunPod serverless render → presigned mp4.
 *
 * Prereqs: ECHOMIMIC_ENDPOINT_ID (or RUNPOD_ENDPOINT_ID), RUNPOD_API_KEY,
 *          ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, R2_* in .env
 *
 * Usage:
 *   node scripts/echomimic_smoke.js                       # default 3s line
 *   node scripts/echomimic_smoke.js "Custom short line."  # your text (must fit 3.24s window)
 *
 * Cost: one serverless render (~$0.01-0.02 on A40) + pennies of ElevenLabs TTS.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const avatar = require('../lib/avatar');

const TEXT = process.argv[2] || 'Welcome back to ClipzWorld. Tonight is going to be wild.';

async function main() {
  console.log(`[smoke] engine=echomimic text="${TEXT}"`);

  const config = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' }, { engine: 'echomimic' });
  console.log(`[smoke] config: portrait=${config.avatarId} steps=${config.steps} voice=${config.voiceId.slice(0, 6)}...`);

  const t0 = Date.now();
  const { videoId } = await avatar.submitSegment(
    { text: TEXT, title: 'SMOKE TEST', aspectRatio: '16:9', config },
    { engine: 'echomimic' }
  );
  console.log(`[smoke] submitted in ${((Date.now() - t0) / 1000).toFixed(1)}s — videoId: ${videoId}`);

  // Cold start (~45s model load) + render — allow 15 min.
  const { videoUrl } = await avatar.waitForSegment(videoId, {
    engine: 'echomimic',
    maxWaitMs: 15 * 60 * 1000,
    pollIntervalMs: 10000,
    label: 'SMOKE TEST'
  });

  console.log(`[smoke] ✅ render complete in ${((Date.now() - t0) / 1000).toFixed(1)}s total`);
  console.log(`[smoke] presigned mp4 (24h):\n${videoUrl}`);
}

(async () => {
  try {
    await main();
  } catch (e) {
    console.error(`[smoke] ❌ ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (process.env.ECHOMIMIC_RENDER_MODE === 'pod' || process.env.ECHOMIMIC_POD_ID) {
      try {
        await require('../lib/avatar/echomimic_pod').stopPod();
      } catch (e) {
        console.warn(`[smoke] pod stop: ${e.message}`);
      }
    }
  }
})();
