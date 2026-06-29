'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('long-form group concat uses xfade helper wired to transition param', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/assembly.js'), 'utf8');
  assert.match(src, /async function concatMediaWithTransition\(/);
  assert.match(src, /xfade=transition=/);
  assert.match(src, /acrossfade=d=/);
  assert.match(src, /mergeTwoWithHoldCut/);
  assert.match(src, /concatTsToMp4 = async \(tsList, outMp4, encodeAudio = true, trans = transition, tsTypes = null, tsLabels = null\)/);
  assert.match(src, /concatMediaWithTransition\(stitchPaths, stitchTmp/);
});

test('soupJoinTransition: per-boundary streamer block policy', () => {
  const { soupJoinTransition } = require('../lib/assembly');
  assert.equal(soupJoinTransition('source_clip', 'avatar').useXfade, false);
  assert.equal(soupJoinTransition('avatar', 'source_clip').useXfade, false);
  assert.equal(soupJoinTransition('avatar', 'source_clip').transition, 'cut');
  assert.equal(soupJoinTransition('avatar', 'source_clip', 'LACY_CLIP1_SETUP', 'LACY_CLIP1_SETUP_CLIP').audioFadeSec, 0.05);

  const introSetup = soupJoinTransition('avatar', 'avatar', 'LACY_INTRO', 'LACY_CLIP1_SETUP');
  assert.equal(introSetup.useXfade, true);
  assert.equal(introSetup.videoDur, 0.22);
  assert.equal(introSetup.prepStableTail, true);
  assert.equal(introSetup.sceneReset, true);

  const reactionSetup = soupJoinTransition('avatar', 'avatar', 'LACY_CLIP1_REACTION', 'LACY_CLIP2_SETUP');
  assert.equal(reactionSetup.useXfade, true);
  assert.equal(reactionSetup.fadeReactionTail, true);
  assert.equal(reactionSetup.prepStableTail, true);

  const handoff = soupJoinTransition('avatar', 'avatar', 'LACY_CLIP2_REACTION', 'JASON_INTRO');
  assert.equal(handoff.useXfade, true);
  assert.equal(handoff.videoDur, 0.22);
  assert.equal(handoff.streamerHandoff, true);
  assert.equal(handoff.fadeReactionTail, true);
  assert.equal(handoff.prepStableTail, true);
});

test('concatMediaWithTransition uses mixed path when hold_cut joins present', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/assembly.js'), 'utf8');
  assert.match(src, /hasHoldCut/);
  assert.match(src, /prepStableTail/);
  assert.match(src, /soupSceneResetXfade/);
  assert.match(src, /soup_segment_prep/);
});
