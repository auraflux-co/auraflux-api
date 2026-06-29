#!/usr/bin/env node
'use strict';
/** Submit merged LACY_INTRO+CLIP1_SETUP to HeyGen — proves 009 join eliminated. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const avatar = require('../lib/avatar');
const { downloadFile } = require('../lib/downloader');
const { parseScriptIntoScenes } = require('../lib/qa');
const { mergeIntroClip1SetupScenes } = require('../lib/soup_intro_clip1_merge');
const { prepareHeyGenScript } = require('../lib/heygen_script');

const ROOT = path.join(__dirname, '..');
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'jobs.json'), 'utf8'))
  ['script_twitch_1782513992551'].heygen.sceneTextMap;

const introText = map.LACY_INTRO.text;
const setupText = map.LACY_CLIP1_SETUP.text;
const merged = `${introText.trim()}\n[beat]\n${setupText.trim()}`;

const OUT = path.join(ROOT, 'output', 'scene_reset_hold_test_2026-06-29T21-16-16', 'merged_intro_clip1');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const cfg = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' });
  cfg.reactionPauseSec = 4;
  console.log('Merged HeyGen script:', prepareHeyGenScript(merged, { sceneName: 'LACY_INTRO', ...cfg }));
  const { videoId } = await avatar.submitSegment({
    text: merged,
    title: `merged_LACY_INTRO_CLIP1_SETUP_${Date.now()}`,
    aspectRatio: '16:9',
    config: cfg,
    sceneName: 'LACY_INTRO',
  });
  const { videoUrl } = await avatar.waitForSegment(videoId, {
    maxWaitMs: 90 * 60 * 1000,
    pollIntervalMs: 15000,
    label: 'LACY_INTRO merged',
  });
  const dest = path.join(OUT, 'LACY_INTRO_CLIP1_SETUP_merged.mp4');
  await downloadFile(videoUrl, dest);
  console.log('Saved', dest);
  console.log('No intro→setup join — one continuous HeyGen take through setup lines.');
})().catch((e) => { console.error(e); process.exit(1); });
