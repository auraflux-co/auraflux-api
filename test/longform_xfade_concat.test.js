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
  assert.equal(soupJoinTransition('avatar', 'source_clip').useXfade, true);

  const introSetup = soupJoinTransition('avatar', 'avatar', 'LACY_INTRO', 'LACY_CLIP1_SETUP');
  assert.equal(introSetup.mode, 'hold_cut');
  assert.equal(introSetup.useXfade, false);

  const reactionSetup = soupJoinTransition('avatar', 'avatar', 'LACY_CLIP1_REACTION', 'LACY_CLIP2_SETUP');
  assert.equal(reactionSetup.useXfade, true);
  assert.equal(reactionSetup.fadeReactionTail, true);

  const handoff = soupJoinTransition('avatar', 'avatar', 'LACY_CLIP2_REACTION', 'JASON_INTRO');
  assert.equal(handoff.useXfade, true);
  assert.equal(handoff.streamerHandoff, true);
  assert.equal(handoff.reactionTailFadeSec, 0.45);
});

test('concatMediaWithTransition accepts segTypes for mixed join policy', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/assembly.js'), 'utf8');
  assert.match(src, /segTypes/);
  assert.match(src, /soupJoinUsesXfade/);
  assert.match(src, /mergeTwoWithCut/);
  assert.match(src, /concatTsToMp4\(voResult\.files, groupMp4, true, transition, voResult\.types, voResult\.labels\)/);
});
