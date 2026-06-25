'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveBedPath,
  resolveCutSfxPath,
  shouldMixCompAudio,
  sidechainBedParams,
  buildCompAudioFilterParts,
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

test('serpent_ranked uses constant quiet bed without sidechain duck', () => {
  const sc = sidechainBedParams(PRESET_DEFAULTS.serpent_ranked.audio);
  assert.equal(sc, null);
  const { filterParts } = buildCompAudioFilterParts({
    totalDur: 60,
    bedVol: 0.018,
    bedInputIdx: 1,
    duckParams: sc,
    boundaries: [12, 24],
    sfxInputStartIdx: 2,
    sfxPaths: ['whoosh.mp3', 'impact.mp3'],
  });
  const graph = filterParts.join(';');
  assert.match(graph, /volume=0\.0180.*\[bedraw\]/);
  assert.doesNotMatch(graph, /sidechaincompress/);
  assert.doesNotMatch(graph, /bedfloor/);
  assert.match(graph, /amix=inputs=4:weights=1 0\.22 0\.38 0\.38:normalize=0/);
});

test('optional duck path still available for other presets', () => {
  const sc = sidechainBedParams({ duckSpeech: true });
  assert.ok(sc);
  const { filterParts } = buildCompAudioFilterParts({
    totalDur: 60,
    bedVol: 0.05,
    bedInputIdx: 1,
    duckParams: sc,
    boundaries: [],
    sfxInputStartIdx: 2,
    sfxPaths: [],
  });
  const graph = filterParts.join(';');
  assert.match(graph, /sidechaincompress=.*mix=0\.1/);
});
