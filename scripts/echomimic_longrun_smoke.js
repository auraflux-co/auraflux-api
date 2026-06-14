#!/usr/bin/env node
'use strict';
/**
 * Long-run proof: two avatar scenes with multi-window chunking (pod mode).
 * Exercises wake → chunk TTS → sequential renders → concat → stop.
 *
 * Usage: node scripts/echomimic_longrun_smoke.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const avatar = require('../lib/avatar');
const pod = require('../lib/avatar/echomimic_pod');

const SCENES = [
  {
    name: 'INTRO',
    text: 'Welcome back to ClipzWorld. Tonight we are tracking two stories that actually matter. Stay with us.'
  },
  {
    name: 'OUTRO',
    text: 'That is the wrap for tonight. Hit follow if you want the next drop. We will see you on the timeline.'
  }
];

(async () => {
  const config = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' }, { engine: 'echomimic' });
  const t0 = Date.now();
  const results = [];

  try {
    for (let i = 0; i < SCENES.length; i++) {
      const scene = SCENES[i];
      console.log(`\n[longrun] scene ${i + 1}/${SCENES.length}: ${scene.name}`);
      const t1 = Date.now();
      const { videoId, status, videoUrl } = await avatar.submitSegment(
        { text: scene.text, title: scene.name, aspectRatio: '16:9', config },
        { engine: 'echomimic' }
      );
      results.push({ scene: scene.name, videoId, status, videoUrl, sec: ((Date.now() - t1) / 1000).toFixed(1) });
      console.log(`[longrun] ✅ ${scene.name} ${status} in ${results[results.length - 1].sec}s`);
    }
    console.log(`\n[longrun] ✅ all scenes done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(JSON.stringify(results, null, 2));
  } catch (e) {
    console.error(`[longrun] ❌ ${e.message}`);
    process.exitCode = 1;
  } finally {
    try { await pod.stopPod(); } catch (e) { console.warn(`[longrun] pod stop: ${e.message}`); }
  }
})();
