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

test('soupJoinTransition: all avatar dialogues use gold-standard 0.22s crossfade', () => {
  const { soupJoinTransition } = require('../lib/assembly');
  assert.equal(soupJoinTransition('source_clip', 'avatar').useXfade, false);
  assert.equal(soupJoinTransition('avatar', 'source_clip').useXfade, true);

  const gold = soupJoinTransition('avatar', 'avatar', 'LACY_CLIP2_REACTION', 'JASON_INTRO');
  const introSetup = soupJoinTransition('avatar', 'avatar', 'LACY_INTRO', 'LACY_CLIP1_SETUP');
  const reactionSetup = soupJoinTransition('avatar', 'avatar', 'LACY_CLIP1_REACTION', 'LACY_CLIP2_SETUP');

  for (const spec of [gold, introSetup, reactionSetup]) {
    assert.equal(spec.useXfade, true);
    assert.equal(spec.videoDur, 0.22);
    assert.equal(spec.transition, 'crossfade');
  }
  assert.equal(introSetup.sceneReset, true);
  assert.equal(reactionSetup.sceneReset, true);
  assert.equal(reactionSetup.fadeReactionTail, true);
  assert.equal(reactionSetup.reactionTailFadeSec, 0.35);
  assert.equal(gold.sceneReset, false);
});

test('concatMediaWithTransition accepts segTypes for mixed join policy', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/assembly.js'), 'utf8');
  assert.match(src, /segTypes/);
  assert.match(src, /soupJoinUsesXfade/);
  assert.match(src, /mergeTwoWithCut/);
  assert.match(src, /concatTsToMp4\(voResult\.files, groupMp4, true, transition, voResult\.types, voResult\.labels\)/);
});
