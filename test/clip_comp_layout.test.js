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
  insetRectAwayFromChatRail,
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

test('blur_pad mode describes brand-pad navy fill (not gblur vstack)', () => {
  const d = layoutFilterDescription('blur_pad');
  assert.match(d, /brand-pad/i);
  assert.match(d, /0d1424/);
  assert.doesNotMatch(d, /c7af4f|gold/i);
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

test('CPD-1257 classic + timed full-bleed coerces logo to corner top-right', () => {
  const {
    collectLayoutModesFromClips,
    coerceLogoCreativeForOutput,
  } = require('../lib/clip_comp_layout');
  const classic = JSON.parse(JSON.stringify(PRESET_DEFAULTS.classic_blur_pad));
  assert.equal(resolveLogoMode(classic), 'top_blur_fold');
  const modes = collectLayoutModesFromClips([{
    openingLayout: { mode: 'split_screen' },
    layoutSegments: [{ atSec: 21, mode: 'full_bleed_crop' }],
  }]);
  assert.deepEqual(modes, ['split_screen', 'full_bleed_crop']);
  const coerced = coerceLogoCreativeForOutput(classic, { layoutModes: modes });
  assert.equal(resolveLogoMode(coerced), 'corner');
  assert.equal(resolveLogoCorner(coerced), 'top_right');
  const fc = buildClipCompLogoFilter(coerced, '/tmp/logo.png');
  assert.ok(fc.includes('y=20'));
  assert.ok(!fc.includes('y=H-h-20'));
});

test('CPD-1257 classic-only plan keeps top_blur_fold logo', () => {
  const { coerceLogoCreativeForOutput } = require('../lib/clip_comp_layout');
  const classic = JSON.parse(JSON.stringify(PRESET_DEFAULTS.classic_blur_pad));
  const coerced = coerceLogoCreativeForOutput(classic, {
    layoutModes: ['blur_pad'],
  });
  assert.equal(resolveLogoMode(coerced), 'top_blur_fold');
});

test('CPD-1257 collectLayoutModesFromClips accepts object-shaped layoutSegments', () => {
  const { collectLayoutModesFromClips } = require('../lib/clip_comp_layout');
  const modes = collectLayoutModesFromClips([{
    openingLayout: { mode: 'split_screen' },
    layoutSegments: { mode: 'split_screen', segments: [{ atSec: 21, mode: 'full_bleed_crop' }] },
  }]);
  assert.deepEqual(modes, ['split_screen', 'split_screen', 'full_bleed_crop']);
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

test('buildFullBleedFilter centres by default, offsets toward subject, supports zoom (CPD-1227)', () => {
  const { buildFullBleedFilter, resolveFullBleedSourceRect } = require('../lib/clip_comp_layout');
  assert.equal(buildFullBleedFilter(), FULL_BLEED_FILTER);
  assert.equal(buildFullBleedFilter(null, null), FULL_BLEED_FILTER);
  assert.equal(buildFullBleedFilter(0.5, 0.5), FULL_BLEED_FILTER);
  assert.equal(buildFullBleedFilter('junk', undefined), FULL_BLEED_FILTER);

  const left = buildFullBleedFilter(0.2, null);
  assert.ok(left.includes('crop=trunc(iw*'));
  assert.ok(left.includes('scale=1080:1920:force_original_aspect_ratio=increase'));
  assert.ok(!/,scale=1080:1920,format=/.test(left), 'must not stretch-scale');

  const both = buildFullBleedFilter(0.8, 0.3);
  assert.ok(both.includes('crop=trunc(iw*'));
  assert.ok(both.includes('force_original_aspect_ratio=increase'));

  // Zoom-out (<1) clamps to max true-9:16 window — never widen past ratio (smear bands).
  const rectDefault = resolveFullBleedSourceRect(0.5, 0.5, 1);
  const rectOut = resolveFullBleedSourceRect(0.5, 0.5, 0.5);
  assert.equal(rectOut.w, rectDefault.w);
  assert.equal(rectOut.h, rectDefault.h);
  assert.ok(Math.abs((rectDefault.w / rectDefault.h) - ((9 / 16) / (16 / 9))) < 0.001
    || Math.abs(rectDefault.h - 1) < 0.001);
  const zoomedOut = buildFullBleedFilter(0.5, 0.5, 0.5);
  assert.ok(zoomedOut.includes('force_original_aspect_ratio=increase'));

  const zoomedIn = buildFullBleedFilter(0.5, 0.5, 2);
  const rectIn = resolveFullBleedSourceRect(0.5, 0.5, 2);
  assert.ok(rectIn.w < rectDefault.w);
  assert.ok(zoomedIn.includes(`iw*${rectIn.w.toFixed(4)}`));
  // Pixel aspect of crop window must stay 9:16
  const pxRatio = (rectIn.w * (16 / 9)) / rectIn.h;
  assert.ok(Math.abs(pxRatio - 9 / 16) < 0.01);
});

test('resolveFullBleedSubject honours operator cropCx/cropCy/cropZoom override (CPD-1227)', async () => {
  const { resolveFullBleedSubject } = require('../lib/clip_comp_layout');
  const r = await resolveFullBleedSubject('/nonexistent.mp4', { layout: { cropCx: 0.72, cropCy: 0.4 } }, null);
  assert.equal(r.subjectCx, 0.72);
  assert.equal(r.subjectCy, 0.4);
  assert.equal(r.cropZoom, 1);
  const cxOnly = await resolveFullBleedSubject('/nonexistent.mp4', { layout: { cropCx: 0.72 } }, null);
  assert.equal(cxOnly.subjectCx, 0.72);
  assert.equal(cxOnly.subjectCy, null);
  assert.equal(cxOnly.cropZoom, 1);
  const withZoom = await resolveFullBleedSubject('/nonexistent.mp4', { layout: { cropZoom: 0.6 } }, null);
  assert.equal(withZoom.cropZoom, 0.6);
});

// ─── Facecam split (CPD-1228) ────────────────────────────────────────────────

test('buildSplitScreenFilter builds vstack graph with even-aligned cam crop', () => {
  const { buildSplitScreenFilter } = require('../lib/clip_comp_layout');
  const f = buildSplitScreenFilter({ x: 0.7, y: 0.05, w: 0.25, h: 0.3 });
  assert.ok(f.includes('split=2[camsrc][contentsrc]'));
  // y=0.05 is below TOP_CHROME_SAFE 0.10 — facecam shrinks from top (keeps bottom).
  assert.ok(f.includes('crop=trunc(iw*0.2500/2)*2:trunc(ih*0.2500/2)*2:trunc(iw*0.7000/2)*2:trunc(ih*0.1000/2)*2'));
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

test('buildSplitScreenFilter bottomPaneRect isolates bottom pane crop (dual figure stack)', () => {
  const { buildSplitScreenFilter } = require('../lib/clip_comp_layout');
  const f = buildSplitScreenFilter(
    { x: 0.3, y: 0.05, w: 0.35, h: 0.4 },
    { bottomPaneRect: { x: 0.1, y: 0.45, w: 0.8, h: 0.5 } },
  );
  // Facecam y inset to 0.10; shrink-from-top → h=0.35
  assert.ok(f.includes('crop=trunc(iw*0.3500/2)*2:trunc(ih*0.3500/2)*2:trunc(iw*0.3000/2)*2:trunc(ih*0.1000/2)*2'));
  // Bottom pane y=0.45 h=0.50 → clipped above default bottom chrome (0.06) → h=0.49
  assert.ok(f.includes('crop=trunc(iw*0.8000/2)*2:trunc(ih*0.4900/2)*2:trunc(iw*0.1000/2)*2:trunc(ih*0.4500/2)*2'));
  // Top-biased second crop (not centered) avoids floor letterbox black bars
  assert.ok(f.includes('crop=1080:1280:(iw-1080)/2:0'));
});

test('buildSplitScreenFilter insets bottomPaneRect when operator starts at y=0 (desktop chrome)', () => {
  const { buildSplitScreenFilter } = require('../lib/clip_comp_layout');
  const f = buildSplitScreenFilter(
    { x: 0, y: 0, w: 0.36, h: 0.38 },
    {
      bottomPaneRect: { x: 0.31, y: 0, w: 0.43, h: 0.80 },
      topChromeSafe: 0.14,
      bottomChromeSafe: 0.06,
      topHeight: 634,
    },
  );
  // Facecam shrink-from-top: y=0.14, h=0.24 (keeps PIP face)
  assert.ok(f.includes('crop=trunc(iw*0.3600/2)*2:trunc(ih*0.2400/2)*2:trunc(iw*0.0000/2)*2:trunc(ih*0.1400/2)*2'));
  // Bottom pane: topSafe 0.14+0.06=0.20, bottomSafe 0.06 → h=0.94-0.20=0.74
  assert.ok(f.includes('crop=trunc(iw*0.4300/2)*2:trunc(ih*0.7400/2)*2:trunc(iw*0.3100/2)*2:trunc(ih*0.2000/2)*2'));
  assert.ok(f.includes('crop=1080:1286:(iw-1080)/2:0'));
});

test('buildSplitScreenFilter honorOperatorCrops keeps Save-look boxes (CPD-1314)', () => {
  const { buildSplitScreenFilter } = require('../lib/clip_comp_layout');
  const f = buildSplitScreenFilter(
    { x: 0.32, y: 0.04, w: 0.36, h: 0.38 },
    {
      bottomPaneRect: { x: 0.28, y: 0.02, w: 0.43, h: 0.80 },
      honorOperatorCrops: true,
      topChromeSafe: 0.14,
      bottomChromeSafe: 0.06,
    },
  );
  assert.ok(f.includes('crop=trunc(iw*0.3600/2)*2:trunc(ih*0.3800/2)*2:trunc(iw*0.3200/2)*2:trunc(ih*0.0400/2)*2'));
  assert.ok(f.includes('crop=trunc(iw*0.4300/2)*2:trunc(ih*0.8000/2)*2:trunc(iw*0.2800/2)*2:trunc(ih*0.0200/2)*2'));
  assert.ok(f.includes('scale=1080:640'));
  assert.ok(f.includes('scale=1080:1280'));
  assert.ok(!f.includes('force_original_aspect_ratio=increase'), 'operator boxes stretch to pane, no cover-crop');
});

test('buildFullBleedFilter with source dims uses exact 9:16 crop (no stretch)', () => {
  const { buildFullBleedFilter } = require('../lib/clip_comp_layout');
  const f = buildFullBleedFilter(0.42, 0.5, 1, 16 / 9, {
    topMargin: 0.15,
    bottomMargin: 0.15,
    sourceWidth: 1920,
    sourceHeight: 1080,
  });
  // crop=W:H:x:y with W/H === 9/16 and both multiples of 2
  const m = f.match(/^crop=(\d+):(\d+):(\d+):(\d+),scale=1080:1920,/);
  assert.ok(m, `expected pixel crop filter, got: ${f}`);
  const [, w, h] = m.map(Number);
  assert.equal(w % 2, 0);
  assert.equal(h % 2, 0);
  assert.equal(w / h, 9 / 16);
  assert.ok(!f.includes('force_original_aspect_ratio'), 'exact ratio needs no second crop');
});

test('resolveFullBleedSourceRect folds edge margins into true 9:16 window', () => {
  const { resolveFullBleedSourceRect } = require('../lib/clip_comp_layout');
  const plain = resolveFullBleedSourceRect(0.5, 0.5, 1, 16 / 9);
  const trimmed = resolveFullBleedSourceRect(0.5, 0.5, 1, 16 / 9, { topMargin: 0.08, bottomMargin: 0.08 });
  assert.ok(trimmed.y >= 0.08 - 1e-9);
  assert.ok(trimmed.y + trimmed.h <= 0.92 + 1e-9);
  assert.ok(trimmed.h < plain.h);
  // Still a true 9:16 pixel window on 16:9 source
  const targetWH = (9 / 16) / (16 / 9);
  assert.ok(Math.abs((trimmed.w / trimmed.h) - targetWH) < 0.001);
});

test('splitPaneNormAspect matches top and bottom shape at 50/50 split', () => {
  const { splitPaneNormAspect } = require('../lib/clip_comp_layout');
  const a = splitPaneNormAspect(960);
  assert.equal(a.topHeight, 960);
  assert.equal(a.bottomHeight, 960);
  assert.ok(Math.abs(a.topNormWH - a.bottomNormWH) < 1e-9);
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

test('resolveSplitTopHeight honours operator layout.topHeight', () => {
  const { resolveSplitTopHeight, resolveHookMidY, SPLIT_TOP_HEIGHT } = require('../lib/clip_comp_layout');
  assert.equal(resolveSplitTopHeight(null), SPLIT_TOP_HEIGHT);
  assert.equal(resolveSplitTopHeight({ layout: { topHeight: 960 } }), 960);
  assert.equal(resolveSplitTopHeight({ layout: { topHeight: 639 } }), 640);
  assert.equal(resolveHookMidY({ layout: { topHeight: 960 }, preset: 'facecam_split' }, 'split_screen'), 984);
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

test('defaultLandscapeFacecamRect returns top-right twitch box', () => {
  const { defaultLandscapeFacecamRect } = require('../lib/clip_comp_layout');
  const r = defaultLandscapeFacecamRect(null);
  assert.ok(r.x > 0.5);
  assert.ok(r.y < 0.1);
  assert.ok(r.w >= 0.05);
});

 test('resolveEffectiveLayoutMode keeps blur_pad without probing', async () => {
  const { resolveEffectiveLayoutMode } = require('../lib/clip_comp_layout');
  const r = await resolveEffectiveLayoutMode('/nonexistent.mp4', PRESET_DEFAULTS.classic_blur_pad, null);
  assert.equal(r.mode, 'blur_pad');
  assert.equal(r.facecamRect, null);
});

test('resolveEffectiveLayoutMode honours landscapeSplit false (single view)', async () => {
  const { resolveEffectiveLayoutMode } = require('../lib/clip_comp_layout');
  const creative = {
    preset: 'dahbluh_clean',
    layout: { mode: 'full_bleed_crop', landscapeSplit: false },
  };
  const r = await resolveEffectiveLayoutMode('/nonexistent.mp4', creative, null);
  assert.equal(r.mode, 'full_bleed_crop');
  assert.equal(r.facecamRect, null);
});

test('resolveFullBleedSourceRect uses full frame for portrait source at zoom 1', () => {
  const { resolveFullBleedSourceRect } = require('../lib/clip_comp_layout');
  const r = resolveFullBleedSourceRect(0.5, 0.5, 1, 9 / 16);
  assert.equal(r.w, 1);
  assert.equal(r.h, 1);
  const zoomIn = resolveFullBleedSourceRect(0.5, 0.5, 2, 9 / 16);
  assert.equal(zoomIn.w, 0.5);
  assert.equal(zoomIn.h, 0.5);
});

test('resolveEffectiveLayoutMode honours cropZoom without landscapeSplit flag', async () => {
  const { resolveEffectiveLayoutMode } = require('../lib/clip_comp_layout');
  const creative = {
    preset: 'dahbluh_clean',
    layout: { mode: 'full_bleed_crop', cropZoom: 0.25, cropCx: 0.5, cropCy: 0.5 },
  };
  const r = await resolveEffectiveLayoutMode('/nonexistent.mp4', creative, null);
  assert.equal(r.mode, 'full_bleed_crop');
  assert.equal(r.facecamRect, null);
});

 test('probeVideoDimensions returns null for missing file', async () => {
  const { probeVideoDimensions } = require('../lib/clip_comp_layout');
  const dims = await probeVideoDimensions('/nonexistent_clip.mp4');
  assert.equal(dims, null);
});

 test('resolveSplitScreenFacecam honours operator facecamRect override', async () => {
  const { resolveSplitScreenFacecam } = require('../lib/clip_comp_layout');
  const rect = await resolveSplitScreenFacecam('/nonexistent.mp4', {
    layout: { facecamRect: { x: 0.65, y: 0.02, w: 0.3, h: 0.28 } },
  }, null);
  assert.equal(rect.x, 0.65);
  assert.equal(rect.w, 0.3);
});

test('CPD-1293: chat rail inset clamps wide crops left of delogo column', () => {
  const wide = insetRectAwayFromChatRail({ x: 0.42, y: 0, w: 0.58, h: 0.7 }, { hideChatRail: true });
  assert.ok(wide);
  assert.ok(wide.x + wide.w <= 0.78, 'must not overlap chat_rail');
  const untouched = insetRectAwayFromChatRail({ x: 0.1, y: 0.2, w: 0.4, h: 0.5 }, { hideChatRail: true });
  assert.equal(untouched.w, 0.4);
  const off = insetRectAwayFromChatRail({ x: 0.42, y: 0, w: 0.58, h: 0.7 }, { hideChatRail: false });
  assert.equal(off.w, 0.58);
});
