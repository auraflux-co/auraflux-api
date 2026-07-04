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

// ─── Facecam split (CPD-1228) ────────────────────────────────────────────────

test('buildSplitScreenFilter builds vstack graph with even-aligned cam crop', () => {
  const { buildSplitScreenFilter } = require('../lib/clip_comp_layout');
  const f = buildSplitScreenFilter({ x: 0.7, y: 0.05, w: 0.25, h: 0.3 });
  assert.ok(f.includes('split=2[camsrc][contentsrc]'));
  assert.ok(f.includes('crop=trunc(iw*0.2500/2)*2:trunc(ih*0.3000/2)*2:trunc(iw*0.7000/2)*2:trunc(ih*0.0500/2)*2'));
  assert.ok(f.includes('scale=1080:640:force_original_aspect_ratio=increase,crop=1080:640'));
  assert.ok(f.includes('scale=1080:1280:force_original_aspect_ratio=increase,crop=1080:1280:(iw-1080)/2:(ih-1280)/2'));
  assert.ok(f.includes('vstack=inputs=2,format=yuv420p[vout]'));
});

test('buildSplitScreenFilter rejects invalid rects', () => {
  const { buildSplitScreenFilter } = require('../lib/clip_comp_layout');
  assert.throws(() => buildSplitScreenFilter(null));
  assert.throws(() => buildSplitScreenFilter({ x: 0.1, y: 0.1, w: 0.01, h: 0.3 }));
  assert.throws(() => buildSplitScreenFilter({ x: 'a', y: 0, w: 0.2, h: 0.2 }));
});

test('buildSplitScreenFilter honours contentCx offset and bottom crop on content pane only', () => {
  const { buildSplitScreenFilter } = require('../lib/clip_comp_layout');
  const f = buildSplitScreenFilter({ x: 0, y: 0, w: 0.3, h: 0.3 }, { contentCx: 0.8, bottomCropPct: 0.1 });
  assert.ok(f.includes('crop=1080:1280:trunc((iw-1080)*0.800/2)*2'));
  const chains = f.split(';');
  const contentChain = chains.find((c) => c.startsWith('[contentsrc]'));
  const camChain = chains.find((c) => c.startsWith('[camsrc]'));
  assert.ok(contentChain.includes('crop=iw:trunc(ih*0.900/2)*2:0:0'));
  assert.ok(!camChain.includes('0.900'));
});

test('buildSplitScreenFilter topHeight is clamped and even-aligned', () => {
  const { buildSplitScreenFilter } = require('../lib/clip_comp_layout');
  const odd = buildSplitScreenFilter({ x: 0, y: 0, w: 0.3, h: 0.3 }, { topHeight: 641 });
  assert.ok(odd.includes('crop=1080:640,') || odd.includes('crop=1080:642,'));
  const low = buildSplitScreenFilter({ x: 0, y: 0, w: 0.3, h: 0.3 }, { topHeight: 100 });
  assert.ok(low.includes('scale=1080:320:'));
  assert.ok(low.includes('scale=1080:1600:'));
});

test('normalizeFacecamRect clamps out-of-range boxes', () => {
  const { normalizeFacecamRect } = require('../lib/clip_comp_layout');
  const r = normalizeFacecamRect({ x: 0.9, y: -0.1, w: 0.5, h: 0.5 });
  assert.equal(r.x, 0.9);
  assert.equal(r.y, 0);
  assert.ok(Math.abs(r.w - 0.1) < 1e-9);
  assert.equal(r.h, 0.5);
  assert.equal(normalizeFacecamRect({ x: 0, y: 0, w: 0.02, h: 0.5 }), null);
  assert.equal(normalizeFacecamRect(undefined), null);
});

test('facecam_split preset routes hook to seam and logo top-right (CPD-1228)', () => {
  const { resolveHookPlacement, resolveHookMidY, resolveLogoCorner, resolveLayoutMode, SPLIT_TOP_HEIGHT } =
    require('../lib/clip_comp_layout');
  const preset = PRESET_DEFAULTS.facecam_split;
  assert.equal(resolveLayoutMode(preset), 'split_screen');
  assert.equal(resolveHookPlacement(preset), 'split_seam');
  assert.equal(resolveHookMidY(preset), SPLIT_TOP_HEIGHT + 24);
  assert.equal(resolveLogoCorner(preset), 'top_right');
});

test('resolveSplitScreenFacecam honours operator facecamRect override', async () => {
  const { resolveSplitScreenFacecam } = require('../lib/clip_comp_layout');
  const rect = await resolveSplitScreenFacecam('/nonexistent.mp4', {
    layout: { facecamRect: { x: 0.65, y: 0.02, w: 0.3, h: 0.28 } },
  }, null);
  assert.equal(rect.x, 0.65);
  assert.equal(rect.w, 0.3);
});
