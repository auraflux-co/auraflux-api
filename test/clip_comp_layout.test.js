'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveLayoutMode,
  resolveLogoMode,
  resolveHookSharpBottom,
  layoutFilterDescription,
  FULL_BLEED_FILTER,
} = require('../lib/clip_comp_layout');
const { PRESET_DEFAULTS } = require('../lib/clip_comp_creative');

test('resolveLayoutMode reads compCreative layout', () => {
  assert.equal(resolveLayoutMode(PRESET_DEFAULTS.full_bleed), 'full_bleed_crop');
  assert.equal(resolveLayoutMode(PRESET_DEFAULTS.classic_blur_pad), 'blur_pad');
});

test('full bleed filter string is stable', () => {
  assert.ok(layoutFilterDescription('full_bleed_crop').includes('1080:1920'));
  assert.equal(FULL_BLEED_FILTER.includes('crop=1080:1920'), true);
});

test('hook sharp bottom differs by layout', () => {
  assert.equal(resolveHookSharpBottom(PRESET_DEFAULTS.full_bleed), 1920);
  assert.ok(resolveHookSharpBottom(PRESET_DEFAULTS.classic_blur_pad) < 1920);
});

test('serpent ranked preset hides logo', () => {
  assert.equal(resolveLogoMode(PRESET_DEFAULTS.serpent_ranked), 'off');
});
