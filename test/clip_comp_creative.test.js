'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeCompCreative,
  compCreativeChips,
  compCreativeAssemblyFlags,
  PRESET_DEFAULTS,
  VALID_PRESETS,
} = require('../lib/clip_comp_creative');

test('mergeCompCreative defaults to classic_blur_pad', () => {
  const c = mergeCompCreative({});
  assert.equal(c.preset, 'classic_blur_pad');
  assert.equal(c.layout.mode, 'blur_pad');
  assert.equal(c.presetVersion, 1);
});

test('mergeCompCreative applies serpent_ranked preset', () => {
  const c = mergeCompCreative({ preset: 'serpent_ranked', streamerHint: 'xQc' });
  assert.equal(c.preset, 'serpent_ranked');
  assert.equal(c.layout.mode, 'full_bleed_crop');
  assert.equal(c.hooks.rankedList.enabled, true);
  assert.equal(c.hooks.rankedList.streamer, 'xQc');
  assert.equal(c.audio.musicBed, 'low_trap');
});

test('mergeCompCreative deep-merges overrides without dropping preset fields', () => {
  const c = mergeCompCreative({
    preset: 'full_bleed',
    overrides: { audio: { musicBed: 'low_trap' } },
  });
  assert.equal(c.preset, 'full_bleed');
  assert.equal(c.layout.mode, 'full_bleed_crop');
  assert.equal(c.audio.musicBed, 'low_trap');
});

test('compCreativeChips reflects ranked list and VOD comp', () => {
  const ranked = compCreativeChips(PRESET_DEFAULTS.serpent_ranked);
  assert.ok(ranked.some((chip) => chip.includes('Ranked') || chip === 'ranked list'));
  assert.ok(ranked.includes('ranked list'));

  const vod = compCreativeChips(PRESET_DEFAULTS.twitch_comp_vod);
  assert.ok(vod.includes('VOD comp'));
});

test('compCreativeAssemblyFlags marks phase1 schema only', () => {
  const flags = compCreativeAssemblyFlags(PRESET_DEFAULTS.serpent_ranked);
  assert.equal(flags.layoutMode, 'full_bleed_crop');
  assert.equal(flags.rankedListEnabled, true);
  assert.equal(flags.phase1SchemaOnly, false);
});

test('VALID_PRESETS includes custom', () => {
  assert.ok(VALID_PRESETS.has('custom'));
  assert.ok(VALID_PRESETS.has('classic_blur_pad'));
});
