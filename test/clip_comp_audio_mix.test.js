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
