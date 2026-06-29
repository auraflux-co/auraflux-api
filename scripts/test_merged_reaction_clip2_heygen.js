#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const avatar = require('../lib/avatar');
const { downloadFile } = require('../lib/downloader');
const { prepareHeyGenScript } = require('../lib/heygen_script');
const { injectStudioLaughPauseInReactionText } = require('../lib/studio_laughter');

const ROOT = path.join(__dirname, '..');
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'jobs.json'), 'utf8'))
  ['script_twitch_1782513992551'].heygen.sceneTextMap;

const rxn = injectStudioLaughPauseInReactionText(map.LACY_CLIP1_REACTION.text);
const setup = map.LACY_CLIP2_SETUP.text;
const merged = `${rxn.trim()}\n${setup.trim()}`;

const OUT = path.join(ROOT, 'output', 'scene_reset_hold_test_2026-06-29T21-16-16', 'merged_reaction_clip2');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const cfg = avatar.resolveConfig({ contentType: 'twitch', format: 'landscape' });
  cfg.reactionPauseSec = 4;
  console.log('Merged:', prepareHeyGenScript(merged, { sceneName: 'LACY_CLIP1_REACTION', ...cfg }));
  const { videoId } = await avatar.submitSegment({
    text: merged,
    title: `merged_LACY_RXN_CLIP2_SETUP_${Date.now()}`,
    aspectRatio: '16:9',
    config: cfg,
    sceneName: 'LACY_CLIP1_REACTION',
  });
  const { videoUrl } = await avatar.waitForSegment(videoId, {
    maxWaitMs: 90 * 60 * 1000,
    pollIntervalMs: 15000,
    label: 'merged reaction+clip2',
  });
  const dest = path.join(OUT, 'LACY_CLIP1_REACTION_CLIP2_SETUP_merged.mp4');
  await downloadFile(videoUrl, dest);
  const { mixCrowdLaughOnReaction } = require('../lib/studio_laughter');
  const withCrowd = await mixCrowdLaughOnReaction(dest, {
    sceneLabel: 'LACY_CLIP1_REACTION',
    outputPath: dest.replace(/\.mp4$/i, '_with_crowd.mp4'),
    log: (m) => console.log(m),
  });
  console.log('Saved', dest);
  console.log('Crowd mix', withCrowd);
})().catch((e) => { console.error(e); process.exit(1); });
