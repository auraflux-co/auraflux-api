'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveBedPath,
  resolveCutSfxPath,
  shouldMixCompAudio,
} = require('../lib/clip_comp_audio_mix');
const { PRESET_DEFAULTS } = require('../lib/clip_comp_creative');

test('resolveBedPath maps low_trap to existing asset', () => {
  const p = resolveBedPath('low_trap');
  assert.ok(p);
  assert.ok(p.endsWith('.mp3'));
});

test('shouldMixCompAudio true when bed or sfx enabled', () => {
  assert.equal(shouldMixCompAudio(PRESET_DEFAULTS.classic_blur_pad), false);
  assert.equal(shouldMixCompAudio(PRESET_DEFAULTS.serpent_ranked), true);
});

test('serpent_pack resolves whoosh sfx', () => {
  assert.ok(resolveCutSfxPath('serpent_pack'));
});

test('sidechainBedParams keeps partial dry mix for speech-heavy clip 1', () => {
  const { sidechainBedParams, buildCompAudioFilterParts } = require('../lib/clip_comp_audio_mix');
  const sc = sidechainBedParams({ duckSpeech: true });
  assert.ok(sc);
  assert.ok(sc.mix < 1);
  assert.ok(sc.ratio <= 8);
  const { filterParts } = buildCompAudioFilterParts({
    totalDur: 60,
    bedVol: 0.055,
    bedInputIdx: 1,
    duckParams: sc,
    boundaries: [12, 24],
    sfxInputStartIdx: 2,
    sfxPaths: ['whoosh.mp3', 'impact.mp3'],
  });
  const graph = filterParts.join(';');
  assert.match(graph, /sidechaincompress=.*mix=0\.18/);
  assert.match(graph, /\[bedfloor\]/);
  assert.match(graph, /\[bedfloorin\]volume=0\.0192/);
  assert.match(graph, /\[1:a\].*atrim=0:60/);
});
