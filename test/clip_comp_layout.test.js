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

test('buildFullBleedFilter centres by default, offsets toward subject (CPD-1227)', () => {
  const { buildFullBleedFilter } = require('../lib/clip_comp_layout');
  assert.equal(buildFullBleedFilter(), FULL_BLEED_FILTER);
  assert.equal(buildFullBleedFilter(null, null), FULL_BLEED_FILTER);
  assert.equal(buildFullBleedFilter(0.5, 0.5), FULL_BLEED_FILTER);
  assert.equal(buildFullBleedFilter('junk', undefined), FULL_BLEED_FILTER);

  const left = buildFullBleedFilter(0.2, null);
  assert.ok(left.includes('crop=1080:1920:trunc((iw-1080)*0.200/2)*2:(ih-1920)/2'));

  const both = buildFullBleedFilter(0.8, 0.3);
  assert.ok(both.includes('trunc((iw-1080)*0.800/2)*2'));
  assert.ok(both.includes('trunc((ih-1920)*0.300/2)*2'));

  const clamped = buildFullBleedFilter(2, -1);
  assert.ok(clamped.includes('*1.000/2'));
  assert.ok(clamped.includes('*0.000/2'));
});

test('resolveFullBleedSubject honours operator cropCx/cropCy override (CPD-1227)', async () => {
  const { resolveFullBleedSubject } = require('../lib/clip_comp_layout');
  const r = await resolveFullBleedSubject('/nonexistent.mp4', { layout: { cropCx: 0.72, cropCy: 0.4 } }, null);
  assert.equal(r.subjectCx, 0.72);
  assert.equal(r.subjectCy, 0.4);
  const cxOnly = await resolveFullBleedSubject('/nonexistent.mp4', { layout: { cropCx: 0.72 } }, null);
  assert.equal(cxOnly.subjectCx, 0.72);
  assert.equal(cxOnly.subjectCy, null);
});
