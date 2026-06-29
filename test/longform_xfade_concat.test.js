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
  assert.match(src, /concatTsToMp4 = async \(tsList, outMp4, encodeAudio = true, trans = transition, tsTypes = null, tsLabels = null\)/);
  assert.match(src, /concatMediaWithTransition\(stitchPaths, stitchTmp/);
});

test('soupJoinTransition: clip hard cut, scene-reset cuts, avatar→clip xfade', () => {
  const { soupJoinTransition } = require('../lib/assembly');
  assert.equal(soupJoinTransition('source_clip', 'avatar').useXfade, false);
  assert.equal(soupJoinTransition('avatar', 'source_clip').useXfade, true);

  const introSetup = soupJoinTransition('avatar', 'avatar', 'LACY_INTRO', 'LACY_CLIP1_SETUP');
  assert.equal(introSetup.useXfade, false);
  assert.equal(introSetup.sceneReset, true);
  assert.equal(introSetup.audioFadeSec, 0.12);

  const reactionSetup = soupJoinTransition('avatar', 'avatar', 'LACY_CLIP1_REACTION', 'LACY_CLIP2_SETUP');
  assert.equal(reactionSetup.useXfade, false);
  assert.equal(reactionSetup.sceneReset, true);
  assert.equal(reactionSetup.fadeReactionTail, true);
  assert.equal(reactionSetup.audioFadeSec, 0.15);

  const crossStreamer = soupJoinTransition('avatar', 'avatar', 'LACY_CLIP2_REACTION', 'JASON_INTRO');
  assert.equal(crossStreamer.useXfade, true);
  assert.equal(crossStreamer.sceneReset, undefined);
});

test('concatMediaWithTransition accepts segTypes for mixed join policy', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/assembly.js'), 'utf8');
  assert.match(src, /segTypes/);
  assert.match(src, /soupJoinUsesXfade/);
  assert.match(src, /mergeTwoWithCut/);
  assert.match(src, /concatTsToMp4\(voResult\.files, groupMp4, true, transition, voResult\.types, voResult\.labels\)/);
});
