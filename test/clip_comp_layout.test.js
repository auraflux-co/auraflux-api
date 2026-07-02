'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveLayoutMode,
  resolveLogoMode,
  resolveLogoCorner,
  resolveHookSharpBottom,
  layoutFilterDescription,
  buildClipCompLogoFilter,
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

test('hook sharp bottom uses blur-pad band for all layouts', () => {
  assert.ok(resolveHookSharpBottom(PRESET_DEFAULTS.full_bleed) < 1920);
  assert.ok(resolveHookSharpBottom(PRESET_DEFAULTS.classic_blur_pad) < 1920);
});

test('full bleed uses upper-mid hook and top-right logo', () => {
  const { resolveHookPlacement } = require('../lib/clip_comp_layout');
  assert.equal(resolveHookPlacement(PRESET_DEFAULTS.full_bleed), 'full_bleed_mid');
  assert.equal(resolveLogoCorner(PRESET_DEFAULTS.full_bleed), 'top_right');
  const fc = buildClipCompLogoFilter(PRESET_DEFAULTS.full_bleed, '/tmp/logo.png');
  assert.ok(fc.includes('y=20'));
  assert.ok(!fc.includes('y=H-h-20'));
});

test('serpent ranked preset uses corner logo bottom-right', () => {
  assert.equal(resolveLogoMode(PRESET_DEFAULTS.serpent_ranked), 'corner');
  assert.equal(resolveLogoCorner(PRESET_DEFAULTS.serpent_ranked), 'bottom_right');
  const fc = buildClipCompLogoFilter(PRESET_DEFAULTS.serpent_ranked, '/tmp/logo.png');
  assert.ok(fc.includes('y=H-h-20'));
});

test('sourceBottomCropPct resolves, defaults to 0, clamps to 0.3 (CPD-1220)', () => {
  const { resolveSourceBottomCropPct } = require('../lib/clip_comp_layout');
  assert.equal(resolveSourceBottomCropPct(null), 0);
  assert.equal(resolveSourceBottomCropPct(PRESET_DEFAULTS.classic_blur_pad), 0);
  assert.equal(resolveSourceBottomCropPct({ layout: { sourceBottomCropPct: 0.12 } }), 0.12);
  assert.equal(resolveSourceBottomCropPct({ layout: { sourceBottomCropPct: 0.9 } }), 0.3);
  assert.equal(resolveSourceBottomCropPct({ layout: { sourceBottomCropPct: -1 } }), 0);
  assert.equal(resolveSourceBottomCropPct({ layout: { sourceBottomCropPct: 'junk' } }), 0);
});
