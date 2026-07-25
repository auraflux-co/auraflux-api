'use strict';
/**
 * lib/clip_comp_layout.js — portrait layout modes for clip comps (CPD-1089)
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');

const FULL_BLEED_FILTER =
  'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p';

/** Portrait window width on a 16:9 source (matches Composer cyan box). */
const FULL_BLEED_PORTRAIT_W_FRAC = (9 / 16) / (16 / 9);

function clampCropZoom(z) {
  return Math.max(0.25, Math.min(4, Number(z) || 1));
}

/**
 * Normalised source crop rect for full-bleed single view (CPD-1227 + zoom).
 * cropZoom 1 = default tightness; &lt;1 zooms out; &gt;1 zooms in.
 * @param {number} [sourceAspect=16/9] — probe width/height; portrait sources use centred square crop.
 */
function resolveFullBleedSourceRect(cropCx, cropCy, cropZoom = 1, sourceAspect = 16 / 9, {
  topMargin = 0,
  bottomMargin = 0,
} = {}) {
  const zoom = clampCropZoom(cropZoom);
  const aspect = Number(sourceAspect) > 0 ? Number(sourceAspect) : 16 / 9;
  const isPortrait = aspect < 1.05;
  const topM = Math.max(0, Math.min(0.2, Number(topMargin) || 0));
  const botM = Math.max(0, Math.min(0.2, Number(bottomMargin) || 0));
  const usableH = Math.max(0.4, 1 - topM - botM);

  // Normalised w/h for a true 9:16 pixel window on this source.
  // pixel_w / pixel_h = 9/16 ⇒ w/h = (9/16) / aspect
  const targetWH = (9 / 16) / aspect;

  // Largest 9:16 window that fits in the usable band (zoom = 1).
  let baseW;
  let baseH;
  if (isPortrait) {
    baseW = 1;
    baseH = Math.min(usableH, baseW / targetWH);
  } else {
    baseH = usableH;
    baseW = baseH * targetWH;
    if (baseW > 1) {
      baseW = 1;
      baseH = baseW / targetWH;
      if (baseH > usableH) {
        baseH = usableH;
        baseW = baseH * targetWH;
      }
    }
  }

  const z = Math.max(zoom, 1);
  let w = Math.min(1, baseW / z);
  let h = w / targetWH;
  if (h > usableH) {
    h = usableH;
    w = h * targetWH;
  }
  if (zoom < 1) {
    w = baseW;
    h = baseH;
  }

  const cx = Number.isFinite(Number(cropCx)) ? Number(cropCx) : 0.5;
  const cyRaw = Number.isFinite(Number(cropCy)) ? Number(cropCy) : 0.5;
  // Remap cy from full-frame 0..1 into the usable band centre preference.
  const cy = topM + usableH * cyRaw;
  return {
    x: Math.max(0, Math.min(1 - w, cx - w / 2)),
    y: Math.max(topM, Math.min(topM + usableH - h, cy - h / 2)),
    w,
    h,
  };
}

/**
 * Full-bleed crop with optional subject-centred offset (CPD-1227) and zoom.
 * cx/cy are normalised [0,1] subject centre. cropZoom 1 = default.
 * null/centre/no zoom → identical to FULL_BLEED_FILTER.
 */
function buildFullBleedFilter(subjectCx = null, subjectCy = null, cropZoom = null, sourceAspect = 16 / 9, {
  topMargin = 0,
  bottomMargin = 0,
  sourceWidth = null,
  sourceHeight = null,
} = {}) {
  const cx = subjectCx == null ? NaN : Number(subjectCx);
  const cy = subjectCy == null ? NaN : Number(subjectCy);
  const zoomRaw = cropZoom == null ? NaN : Number(cropZoom);
  const hasCx = Number.isFinite(cx) && Math.abs(cx - 0.5) > 0.01;
  const hasCy = Number.isFinite(cy) && Math.abs(cy - 0.5) > 0.01;
  const hasZoom = Number.isFinite(zoomRaw) && Math.abs(clampCropZoom(zoomRaw) - 1) > 0.02;
  const topM = Math.max(0, Math.min(0.2, Number(topMargin) || 0));
  const botM = Math.max(0, Math.min(0.2, Number(bottomMargin) || 0));
  const hasMargin = topM > 0.001 || botM > 0.001;

  if (!hasCx && !hasCy && !hasZoom && !hasMargin) return FULL_BLEED_FILTER;

  const rect = resolveFullBleedSourceRect(
    hasCx ? cx : 0.5,
    hasCy ? cy : 0.5,
    hasZoom ? zoomRaw : 1,
    sourceAspect,
    { topMargin: topM, bottomMargin: botM },
  );

  const iw = Math.round(Number(sourceWidth) || 0);
  const ih = Math.round(Number(sourceHeight) || 0);
  if (iw >= 16 && ih >= 16) {
    // Exact 9:16 even window: w=18m, h=32m (both even, ratio exact).
    // Bare scale=1080:1920 after a near-9:16 crop STRETCHES the ~0.3% ratio
    // error into visible top/bottom smear bands.
    const even = (n) => {
      const v = Math.max(0, Math.round(n));
      return v % 2 === 0 ? v : Math.max(0, v - 1);
    };
    const y0 = even(ih * topM);
    const y1 = even(ih * (1 - botM));
    const usableH = Math.max(32, y1 - y0);
    const maxW = Math.min(iw, even(iw));
    let m = Math.floor(Math.min(usableH / 32, maxW / 18));
    m = Math.max(1, m);
    let cropW = 18 * m;
    let cropH = 32 * m;
    while ((cropH > usableH || cropW > maxW) && m > 1) {
      m -= 1;
      cropW = 18 * m;
      cropH = 32 * m;
    }
    const cxPx = (hasCx ? cx : 0.5) * iw;
    let x = even(cxPx - cropW / 2);
    x = Math.max(0, Math.min(iw - cropW, x));
    let y = even(ih * rect.y);
    y = Math.max(y0, Math.min(y1 - cropH, y));
    return `crop=${cropW}:${cropH}:${x}:${y},scale=1080:1920,setsar=1,format=yuv420p`;
  }

  const f = (v) => Math.max(0, Math.min(1, v)).toFixed(4);
  return `crop=trunc(iw*${f(rect.w)}/2)*2:trunc(ih*${f(rect.h)}/2)*2:trunc(iw*${f(rect.x)}/2)*2:trunc(ih*${f(rect.y)}/2)*2,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p`;
}

function resolveLayoutMode(compCreative) {
  return compCreative?.layout?.mode || 'blur_pad';
}

function resolveLogoMode(compCreative) {
  return compCreative?.layout?.logo || 'top_blur_fold';
}

function resolveLogoCorner(compCreative) {
  const explicit = compCreative?.layout?.logoCorner;
  if (explicit === 'top_right' || explicit === 'bottom_right') return explicit;
  // Full-bleed + split shorts: logo top-right — hook mid, whisper bottom
  const mode = resolveLayoutMode(compCreative);
  if (mode === 'full_bleed_crop' || mode === 'split_screen') return 'top_right';
  return 'bottom_right';
}

/** Collect opening + timed-segment layout modes from clip metas. */
function collectLayoutModesFromClips(clips = []) {
  const modes = [];
  for (const c of clips || []) {
    if (c?.openingLayout?.mode) modes.push(c.openingLayout.mode);
    const ls = c?.layoutSegments;
    // Array (card / compositionSpec) or object { mode, segments } from some UI paths
    const segs = Array.isArray(ls) ? ls : (Array.isArray(ls?.segments) ? ls.segments : []);
    if (!Array.isArray(ls) && ls?.mode) modes.push(ls.mode);
    for (const s of segs) {
      if (s?.mode) modes.push(s.mode);
    }
  }
  return modes;
}

function layoutModesNeedCornerLogo(modes = [], compCreative = null) {
  const all = [...(modes || []), resolveLayoutMode(compCreative)];
  return all.some((m) => m === 'full_bleed_crop' || m === 'split_screen');
}

/**
 * CPD-1257 — When any clip look is full-bleed or split, burn logo as corner top-right.
 * Classic `top_blur_fold` only when the whole plan stays brand-pad (no full-bleed/split looks).
 * Ranked presets keep explicit bottom_right corner.
 */
function coerceLogoCreativeForOutput(compCreative, { layoutModes = [] } = {}) {
  if (!compCreative) return compCreative;
  if (resolveLogoMode(compCreative) === 'off') return compCreative;
  if (!layoutModesNeedCornerLogo(layoutModes, compCreative)) return compCreative;
  const next = JSON.parse(JSON.stringify(compCreative));
  next.layout = next.layout || {};
  const ranked = !!next.hooks?.rankedList?.enabled;
  next.layout.logo = 'corner';
  if (ranked && next.layout.logoCorner === 'bottom_right') {
    next.layout.logoCorner = 'bottom_right';
  } else {
    next.layout.logoCorner = 'top_right';
  }
  return next;
}

/** Bottom Y of the sharp footage zone for hook drawtext (blur-pad only). */
function resolveHookSharpBottom(compCreative) {
  const { CONFIG } = require('./config');
  return CONFIG.VISUAL_LAYOUTS?.SHORT_FORM?.CLIP_COMP_SHARP_BOTTOM || 1264;
}

/**
 * Hook burn zone.
 * - blur_pad: bottom of sharp 16:9 band (whisper lives in bottom blur)
 * - full_bleed: upper-mid safe zone (whisper + platform UI stay at bottom)
 * - ranked: mid-frame below header/countdown
 */
function resolveHookPlacement(compCreative, effectiveMode = null) {
  if (compCreative?.hooks?.rankedList?.enabled) return 'ranked_mid';
  const mode = effectiveMode || resolveLayoutMode(compCreative);
  if (mode === 'full_bleed_crop') return 'full_bleed_mid';
  if (mode === 'split_screen') return 'split_seam';
  return 'bottom';
}

function resolveHookMidY(compCreative, effectiveMode = null) {
  const slotCount = compCreative?.hooks?.rankedList?.slotCount || 5;
  if (compCreative?.hooks?.rankedList?.enabled) {
    if (slotCount > 6) return 680;
    return 560 + Math.max(0, 5 - slotCount) * 12;
  }
  // Full-bleed single-clip: lower mid — keep hook off eyes on tight face crops
  // while still clearing Shorts/TikTok bottom UI (~22% ≈ y≥1498).
  const mode = effectiveMode || resolveLayoutMode(compCreative);
  if (mode === 'full_bleed_crop') return 920;
  // Split: hook rides just below the cam/content seam
  if (mode === 'split_screen') return resolveSplitTopHeight(compCreative) + 24;
  return 680;
}

function layoutFilterDescription(mode) {
  if (mode === 'full_bleed_crop') return FULL_BLEED_FILTER;
  if (mode === 'split_screen') return 'facecam split (cam pane top, full-bleed content pane bottom, vstack)';
  return 'brand-pad (navy #0d1424 fill + full-width sharp clip centered)';
}

/**
 * Trim baked-in stretch/smear bands often present on desktop VOD captures.
 * Normalised fractions of source height (each edge).
 */
const SOURCE_EDGE_TRIM = 0.04;

async function applyPortraitFullBleed(inputPath, outputPath, {
  log = null,
  bottomCropPct = 0,
  subjectCx = null,
  subjectCy = null,
  cropZoom = null,
  previewFast = false,
  edgeTrimPct = SOURCE_EDGE_TRIM,
} = {}) {
  const cropPct = Math.max(0, Math.min(0.3, Number(bottomCropPct) || 0));
  const edge = Math.max(0, Math.min(0.2, Number(edgeTrimPct) || 0));
  // Fold edge trim into the 9:16 window (do NOT pre-crop — that changed aspect and
  // then force_original_aspect_ratio=increase reintroduced stretch bands).
  const topMargin = edge;
  const bottomMargin = edge + cropPct;
  const dims = await probeVideoDimensions(inputPath);
  const sourceAspect = dims?.aspect || 16 / 9;
  const filter = buildFullBleedFilter(subjectCx, subjectCy, cropZoom, sourceAspect, {
    topMargin,
    bottomMargin,
    sourceWidth: dims?.width,
    sourceHeight: dims?.height,
  });
  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-vf', filter,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      ...layoutVideoEncodeFlags(previewFast),
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  if (log) {
    const cxNote = ` (subject cx=${Number(subjectCx ?? 0.5).toFixed(2)} cy=${Number(subjectCy ?? 0.5).toFixed(2)} zoom=${clampCropZoom(cropZoom ?? 1).toFixed(2)})`;
    const edgeNote = edge > 0 ? ` (edge trim ${(edge * 100).toFixed(1)}%)` : '';
    log(`[layout] full-bleed crop applied${cxNote}${cropPct > 0 ? ` (bottom crop ${(cropPct * 100).toFixed(0)}%)` : ''}${edgeNote}`);
  }
  return outputPath;
}

const SQUARE_FILTER = 'scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,format=yuv420p';

async function applySquareCrop(inputPath, outputPath, { log = null, previewFast = false } = {}) {
  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-vf', SQUARE_FILTER,
      ...layoutVideoEncodeFlags(previewFast),
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  if (log) log('[layout] 1:1 square crop applied');
  return outputPath;
}

/** CPD-1220: baked-in bottom strips (tickers/social bars) cropped off the source pre-layout. */
function resolveSourceBottomCropPct(compCreative) {
  return Math.max(0, Math.min(0.3, Number(compCreative?.layout?.sourceBottomCropPct) || 0));
}

/**
 * Subject centre for the full-bleed crop window (CPD-1227).
 * Operator override compCreative.layout.cropCx/cropCy wins; otherwise Gemini
 * smart-crop subject detection (same service blur_pad uses); centre on failure.
 */
async function resolveFullBleedSubject(inputPath, compCreative, log) {
  const overrideCx = Number(compCreative?.layout?.cropCx);
  const overrideCy = Number(compCreative?.layout?.cropCy);
  const overrideZoom = Number(compCreative?.layout?.cropZoom);
  if (Number.isFinite(overrideCx) || Number.isFinite(overrideCy) || Number.isFinite(overrideZoom)) {
    if (log) {
      log(`[layout] full-bleed operator crop override cx=${overrideCx} cy=${overrideCy} zoom=${overrideZoom}`);
    }
    return {
      subjectCx: Number.isFinite(overrideCx) ? overrideCx : null,
      subjectCy: Number.isFinite(overrideCy) ? overrideCy : null,
      cropZoom: Number.isFinite(overrideZoom) ? clampCropZoom(overrideZoom) : 1,
    };
  }
  try {
    const { detectSubjectCentre } = require('./services/smart_crop');
    const centre = await detectSubjectCentre(inputPath, 'full_bleed');
    if (centre) return { subjectCx: centre.cx, subjectCy: centre.cy, cropZoom: 1 };
  } catch { /* centre fallback */ }
  return { subjectCx: null, subjectCy: null, cropZoom: 1 };
}

// ─── Split-screen layout — facecam top / content bottom (CPD-1228) ────────────

/** Facecam pane height (px). Content pane gets the remaining 1920−top. */
const SPLIT_TOP_HEIGHT = 640;
const SPLIT_OUTPUT_HEIGHT = 1920;

const SPLIT_OUTPUT_WIDTH = 1080;
const SOURCE_LANDSCAPE_ASPECT = 16 / 9;

function layoutVideoEncodeFlags(previewFast = false) {
  return previewFast
    ? ['-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p'];
}

/**
 * Normalised w/h ratio (on 16:9 source) that matches each split pane's output aspect.
 * Used by Composer crop overlays so green/gold boxes match output pane shape.
 */
function splitPaneNormAspect(topHeight = SPLIT_TOP_HEIGHT) {
  const top = Math.max(320, Math.min(960, Math.round(Number(topHeight) / 2) * 2 || SPLIT_TOP_HEIGHT));
  const bot = SPLIT_OUTPUT_HEIGHT - top;
  return {
    topHeight: top,
    bottomHeight: bot,
    topNormWH: (SPLIT_OUTPUT_WIDTH / top) / SOURCE_LANDSCAPE_ASPECT,
    bottomNormWH: (SPLIT_OUTPUT_WIDTH / bot) / SOURCE_LANDSCAPE_ASPECT,
  };
}

/** Clamp operator/layout topHeight to even px in [320, 960]. */
function resolveSplitTopHeight(compCreative) {
  const raw = Number(compCreative?.layout?.topHeight);
  if (!Number.isFinite(raw)) return SPLIT_TOP_HEIGHT;
  return Math.max(320, Math.min(960, Math.round(raw / 2) * 2 || SPLIT_TOP_HEIGHT));
}

/** Validate a normalised facecam rect {x,y,w,h} — null when unusable. */
function normalizeFacecamRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const w = Number(rect.w);
  const h = Number(rect.h);
  if ([x, y, w, h].some((v) => !Number.isFinite(v))) return null;
  if (w < 0.05 || h < 0.05) return null;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const cx = clamp(x);
  const cy = clamp(y);
  return { x: cx, y: cy, w: Math.min(clamp(w), 1 - cx), h: Math.min(clamp(h), 1 - cy) };
}

/** Default Twitch-style facecam box when Gemini misses — operator can override layout.facecamRect. */
function defaultLandscapeFacecamRect(compCreative = null) {
  const corner = compCreative?.layout?.facecamCorner || 'top_right';
  if (corner === 'top_left') return normalizeFacecamRect({ x: 0.04, y: 0.03, w: 0.28, h: 0.30 });
  if (corner === 'bottom_left') return normalizeFacecamRect({ x: 0.04, y: 0.62, w: 0.28, h: 0.30 });
  if (corner === 'bottom_right') return normalizeFacecamRect({ x: 0.68, y: 0.62, w: 0.28, h: 0.30 });
  return normalizeFacecamRect({ x: 0.68, y: 0.03, w: 0.28, h: 0.30 });
}

async function resolveLandscapeSplitFacecam(inputPath, compCreative, log) {
  const override = normalizeFacecamRect(compCreative?.layout?.facecamRect);
  if (compCreative?.previewFast) {
    if (override) {
      if (log) log(`[layout] preview facecamRect x=${override.x.toFixed(2)} y=${override.y.toFixed(2)}`);
      return override;
    }
    return defaultLandscapeFacecamRect(compCreative);
  }
  if (override) {
    if (log) log(`[layout] operator facecamRect x=${override.x.toFixed(2)} y=${override.y.toFixed(2)} w=${override.w.toFixed(2)} h=${override.h.toFixed(2)}`);
    return override;
  }
  const subject = compCreative?.layout?.topPaneSubject;
  if (subject === 'guest_right_studio') {
    const preset = normalizeFacecamRect({ x: 0.40, y: 0.06, w: 0.42, h: 0.58 });
    if (log) log('[layout] guest_right_studio preset (operator subject, no rect)');
    return preset;
  }
  const detected = await resolveSplitScreenFacecam(inputPath, compCreative, log);
  if (detected) return detected;
  const fallback = defaultLandscapeFacecamRect(compCreative);
  if (log) {
    log(`[layout] landscape split — default ${compCreative?.layout?.facecamCorner || 'top_right'} cam box (set layout.facecamRect to tune)`);
  }
  return fallback;
}

/**
 * Build the -filter_complex graph for the facecam split: the source frame is
 * split in two — the facecam rect fills the top pane, the full frame
 * (full-bleed cropped) fills the bottom pane — so both panes always show the
 * same real-time moment of the clip.
 *
 * @param {{x:number,y:number,w:number,h:number}} facecamRect normalised [0,1]
 * @param {{topHeight?:number, contentCx?:number|null, bottomCropPct?:number, bottomPaneRect?:object|null}} opts
 * @returns {string} filter_complex ending in [vout]
 */
/**
 * Facecam boxes that start at y≈0 pull browser/Twitch chrome into the top pane;
 * scale=increase then magnifies that strip into a smeared band.
 * Nudge the crop down so the face fills the pane instead of the bookmark bar.
 */
/** Default top safe inset — clears browser tabs/bookmarks on desktop captures. */
const TOP_CHROME_SAFE = 0.10;
/** Stronger inset when operator enabled sourceCleanup.hideTopBar. */
const TOP_CHROME_SAFE_DESKTOP = 0.14;
/** Extra top clearance for bottom pane (bookmarks / Twitch search under PIP). */
const BOTTOM_PANE_TOP_EXTRA = 0.06;
/** Keep bottom pane above Windows taskbar / player chrome. */
const BOTTOM_CHROME_SAFE = 0.06;
const BOTTOM_CHROME_SAFE_DESKTOP = 0.06;

/**
 * Facecam PIP: shrink from the top (keep original bottom). Translating a small
 * PIP down slides off the webcam onto the main scene / Students board.
 */
function insetFacecamAwayFromTopChrome(rect, topSafe = TOP_CHROME_SAFE) {
  const r = normalizeFacecamRect(rect);
  if (!r) return null;
  const safe = Math.max(0, Math.min(0.35, Number(topSafe) || TOP_CHROME_SAFE));
  if (r.y >= safe) return r;
  const bottom = r.y + r.h;
  const y = safe;
  const h = Math.max(0.12, bottom - y);
  return normalizeFacecamRect({ x: r.x, y, w: r.w, h });
}

/**
 * Bottom / content pane: clear browser top + OS taskbar. Translate down then
 * clip the bottom — large windows stay on the stream player.
 */
function insetRectAwayFromDesktopChrome(rect, {
  topSafe = TOP_CHROME_SAFE,
  bottomSafe = BOTTOM_CHROME_SAFE,
} = {}) {
  const r = normalizeFacecamRect(rect);
  if (!r) return null;
  const top = Math.max(0, Math.min(0.35, Number(topSafe) || TOP_CHROME_SAFE));
  const bot = Math.max(0, Math.min(0.25, Number(bottomSafe) || BOTTOM_CHROME_SAFE));
  const maxBottom = 1 - bot;

  let y = r.y;
  let h = r.h;
  if (y < top) {
    y = top;
    if (y + h > maxBottom) h = Math.max(0.12, maxBottom - y);
  }
  if (y + h > maxBottom) {
    h = Math.max(0.12, maxBottom - y);
  }
  if (y + h > 1) h = Math.max(0.12, 1 - y);
  return normalizeFacecamRect({ x: r.x, y, w: r.w, h });
}

/** @deprecated alias — bottom/content panes should use insetRectAwayFromDesktopChrome */
function insetRectAwayFromTopChrome(rect, topSafe = TOP_CHROME_SAFE) {
  return insetRectAwayFromDesktopChrome(rect, { topSafe, bottomSafe: BOTTOM_CHROME_SAFE });
}

function resolveTopChromeSafe(compCreative = null) {
  const sc = compCreative?.sourceCleanup;
  if (sc && sc.enabled !== false && sc.hideTopBar) return TOP_CHROME_SAFE_DESKTOP;
  return TOP_CHROME_SAFE;
}

function resolveBottomChromeSafe(compCreative = null) {
  const sc = compCreative?.sourceCleanup;
  // hideTopBar ≈ desktop capture (tabs); also treat hideBottomBar as OS/player chrome present.
  if (sc && sc.enabled !== false && (sc.hideTopBar || sc.hideBottomBar)) {
    return BOTTOM_CHROME_SAFE_DESKTOP;
  }
  return BOTTOM_CHROME_SAFE;
}

function resolveDesktopChromeInsets(compCreative = null) {
  return {
    topSafe: resolveTopChromeSafe(compCreative),
    bottomSafe: resolveBottomChromeSafe(compCreative),
  };
}

function buildSplitScreenFilter(facecamRect, {
  topHeight = SPLIT_TOP_HEIGHT,
  contentCx = null,
  bottomCropPct = 0,
  bottomPaneRect = null,
  topChromeSafe = TOP_CHROME_SAFE,
  bottomChromeSafe = BOTTOM_CHROME_SAFE,
} = {}) {
  // Facecam: shrink-from-top (PIP-safe). Bottom pane: desktop chrome inset.
  const rect = insetFacecamAwayFromTopChrome(facecamRect, topChromeSafe);
  if (!rect) throw new Error('buildSplitScreenFilter requires a valid facecam rect');
  const top = Math.max(320, Math.min(960, Math.round(Number(topHeight) / 2) * 2 || SPLIT_TOP_HEIGHT));
  const bot = 1920 - top;
  const f = (v) => v.toFixed(4);

  // Facecam crop from the source frame — even-aligned for yuv420p
  const camCrop = `crop=trunc(iw*${f(rect.w)}/2)*2:trunc(ih*${f(rect.h)}/2)*2:trunc(iw*${f(rect.x)}/2)*2:trunc(ih*${f(rect.y)}/2)*2`;

  // Baked-in bottom strips (tickers) come off the content pane only — the cam
  // rect was detected on the uncropped frame.
  const cropPct = Math.max(0, Math.min(0.3, Number(bottomCropPct) || 0));
  const contentPre = cropPct > 0 ? `crop=iw:trunc(ih*${(1 - cropPct).toFixed(3)}/2)*2:0:0,` : '';

  // Bottom pane must also clear desktop chrome — operator y≈0 / h≈0.8 pulled bookmarks + taskbar.
  const bottomRect = insetRectAwayFromDesktopChrome(bottomPaneRect, {
    topSafe: Math.min(0.35, topChromeSafe + BOTTOM_PANE_TOP_EXTRA),
    bottomSafe: bottomChromeSafe,
  });
  let bottomChain;
  if (bottomRect) {
    const botCrop = `crop=trunc(iw*${f(bottomRect.w)}/2)*2:trunc(ih*${f(bottomRect.h)}/2)*2:trunc(iw*${f(bottomRect.x)}/2)*2:trunc(ih*${f(bottomRect.y)}/2)*2`;
    // Bias crop toward the top of the scaled pane — centering landscape into a tall
    // bottom pane often lands on dark floor / letterbox → solid black strip.
    bottomChain = `[contentsrc]${contentPre}${botCrop},scale=1080:${bot}:force_original_aspect_ratio=increase,crop=1080:${bot}:(iw-1080)/2:0,setsar=1[bot]`;
  } else {
    const ccx = contentCx == null ? NaN : Number(contentCx);
    const xExpr = Number.isFinite(ccx) && Math.abs(ccx - 0.5) > 0.01
      ? `trunc((iw-1080)*${Math.max(0, Math.min(1, ccx)).toFixed(3)}/2)*2`
      : '(iw-1080)/2';
    bottomChain = `[contentsrc]${contentPre}scale=1080:${bot}:force_original_aspect_ratio=increase,crop=1080:${bot}:${xExpr}:(ih-${bot})/2,setsar=1[bot]`;
  }

  return [
    `[0:v]split=2[camsrc][contentsrc]`,
    `[camsrc]${camCrop},scale=1080:${top}:force_original_aspect_ratio=increase,crop=1080:${top},setsar=1[top]`,
    bottomChain,
    `[top][bot]vstack=inputs=2,format=yuv420p[vout]`,
  ].join(';');
}

async function applyPortraitSplitScreen(inputPath, outputPath, {
  facecamRect,
  log = null,
  bottomCropPct = 0,
  contentCx = null,
  topHeight = SPLIT_TOP_HEIGHT,
  bottomPaneRect = null,
  topChromeSafe = TOP_CHROME_SAFE,
  bottomChromeSafe = BOTTOM_CHROME_SAFE,
  previewFast = false,
} = {}) {
  const filter = buildSplitScreenFilter(facecamRect, {
    topHeight, contentCx, bottomCropPct, bottomPaneRect, topChromeSafe, bottomChromeSafe,
  });
  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-filter_complex', filter,
      '-map', '[vout]', '-map', '0:a?',
      ...layoutVideoEncodeFlags(previewFast),
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  if (log) {
    const r = normalizeFacecamRect(facecamRect);
    const br = normalizeFacecamRect(bottomPaneRect);
    log(`[layout] facecam split applied (top x=${r.x.toFixed(2)} y=${r.y.toFixed(2)} w=${r.w.toFixed(2)} h=${r.h.toFixed(2)}${br ? `; bottom x=${br.x.toFixed(2)} y=${br.y.toFixed(2)} w=${br.w.toFixed(2)} h=${br.h.toFixed(2)}` : ''})`);
  }
  return outputPath;
}

/**
 * Facecam rect for the split top pane (CPD-1228). Operator override
 * compCreative.layout.facecamRect wins; otherwise Gemini facecam detection.
 * null → caller must fall back to blur_pad (never render a broken split).
 */
async function resolveSplitScreenFacecam(inputPath, compCreative, log) {
  const override = normalizeFacecamRect(compCreative?.layout?.facecamRect);
  if (override) {
    if (log) log(`[layout] split-screen operator facecam override x=${override.x} y=${override.y} w=${override.w} h=${override.h}`);
    return override;
  }
  try {
    const { detectFacecamRegion } = require('./services/smart_crop');
    const rect = await detectFacecamRegion(inputPath, 'split_screen');
    return normalizeFacecamRect(rect);
  } catch {
    return null;
  }
}

/**
 * Landscape 16:9 sources always split (CPD-1229): top pane = cam crop, bottom pane =
 * full frame scaled — never centre-crop the desktop away. Portrait-native clips keep
 * the operator preset.
 */
async function resolveEffectiveLayoutMode(inputPath, compCreative, log) {
  const requested = resolveLayoutMode(compCreative);
  const dims = await probeVideoDimensions(inputPath);

  if (!dims?.isLandscape) {
    return { mode: requested, facecamRect: null };
  }

  if (compCreative?.layout?.landscapeSplit === false) {
    if (log) {
      log(`[layout] landscape ${dims.width}x${dims.height} → ${requested} (operator single view)`);
    }
    return { mode: requested, facecamRect: null };
  }

  const layout = compCreative?.layout || {};
  const operatorSingleCrop = layout.cropZoom != null
    || layout.cropCx != null
    || layout.cropCy != null;
  if (operatorSingleCrop && requested !== 'split_screen') {
    if (log) {
      log(`[layout] landscape ${dims.width}x${dims.height} → ${requested} (portrait crop / zoom)`);
    }
    return { mode: requested, facecamRect: null };
  }

  const facecamRect = await resolveLandscapeSplitFacecam(inputPath, compCreative, log);
  if (requested !== 'split_screen' && log) {
    log(`[layout] landscape ${dims.width}x${dims.height} → split (full 16:9 in content pane, was ${requested})`);
  }
  return { mode: 'split_screen', facecamRect };
}

/** @returns {Promise<{width:number,height:number,aspect:number,isLandscape:boolean}|null>} */
async function probeVideoDimensions(filePath) {
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0:s=x', filePath,
    ], { timeout: 10_000 });
    const [w, h] = String(stdout).trim().split('x').map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: w, height: h, aspect: w / h, isLandscape: w > h * 1.05 };
  } catch {
    return null;
  }
}

async function finishPortraitOutput(intermediatePath, outputPath, deliveryAspect, log) {
  if (deliveryAspect === '1:1') {
    await applySquareCrop(intermediatePath, outputPath, { log });
    if (intermediatePath !== outputPath) {
      try { fs.unlinkSync(intermediatePath); } catch (_) { /* ignore */ }
    }
    return outputPath;
  }
  if (intermediatePath !== outputPath && fs.existsSync(intermediatePath)) {
    fs.copyFileSync(intermediatePath, outputPath);
    try { fs.unlinkSync(intermediatePath); } catch (_) { /* ignore */ }
  }
  return outputPath;
}

/**
 * Apply blur-pad or full-bleed portrait layout from compCreative profile.
 */
async function applyPortraitLayout(inputPath, outputPath, {
  compCreative = null,
  log = null,
  effectiveMode = null,
  facecamRect: presetFacecam = null,
  deliveryAspect = '9:16',
} = {}) {
  const layoutOut = deliveryAspect === '1:1' ? `${outputPath}.portrait.mp4` : outputPath;
  let mode = effectiveMode;
  let cachedFacecam = presetFacecam;
  if (!mode) {
    const resolved = await resolveEffectiveLayoutMode(inputPath, compCreative, log);
    mode = resolved.mode;
    cachedFacecam = resolved.facecamRect;
  }
  const bottomCropPct = resolveSourceBottomCropPct(compCreative);
  const previewFast = !!compCreative?.previewFast;
  if (mode === 'split_screen') {
    const rect = cachedFacecam || await resolveLandscapeSplitFacecam(inputPath, compCreative, log);
    if (rect) {
      const contentCx = Number(compCreative?.layout?.contentCx);
      const bottomPaneRect = normalizeFacecamRect(compCreative?.layout?.bottomPaneRect);
      const bottomPaneMode = compCreative?.layout?.bottomPaneMode;
      const useBottomCrop = bottomPaneRect && bottomPaneMode !== 'wide_pan';
      const { topSafe: topChromeSafe, bottomSafe: bottomChromeSafe } = resolveDesktopChromeInsets(compCreative);
      await applyPortraitSplitScreen(inputPath, layoutOut, {
        facecamRect: rect,
        log,
        bottomCropPct,
        contentCx: useBottomCrop ? null : (Number.isFinite(contentCx) ? contentCx : null),
        topHeight: resolveSplitTopHeight(compCreative),
        bottomPaneRect: useBottomCrop ? bottomPaneRect : null,
        topChromeSafe,
        bottomChromeSafe,
        previewFast,
      });
      return finishPortraitOutput(layoutOut, outputPath, deliveryAspect, log);
    }
    if (log) log('[layout] split-screen: no facecam detected — falling back to brand-pad');
  }
  if (mode === 'full_bleed_crop') {
    const { subjectCx, subjectCy, cropZoom } = await resolveFullBleedSubject(inputPath, compCreative, log);
    // Stay clear of sourceCleanup top/bottom blur strips (top_bar≈0.09, bottom_bar≈0.14)
    // AND any baked stream-edge stretch. Intersecting the blur strip looks like smear bands.
    const sc = compCreative?.sourceCleanup;
    const desktop = resolveTopChromeSafe(compCreative) >= TOP_CHROME_SAFE_DESKTOP;
    let edgeTrimPct = SOURCE_EDGE_TRIM;
    if (desktop || (sc && sc.enabled !== false && (sc.hideTopBar || sc.hideBottomBar))) {
      edgeTrimPct = Math.max(SOURCE_EDGE_TRIM, 0.15);
    }
    await applyPortraitFullBleed(inputPath, layoutOut, {
      log, bottomCropPct, subjectCx, subjectCy, cropZoom, previewFast, edgeTrimPct,
    });
    return finishPortraitOutput(layoutOut, outputPath, deliveryAspect, log);
  }
  const { applyPortraitBlurPad } = require('./assembly_postprocess');
  const { CONFIG } = require('./config');
  const padColor = CONFIG.VISUAL_LAYOUTS?.SHORT_FORM?.BRAND_PAD_COLOR || '0x0d1424';
  await applyPortraitBlurPad(inputPath, layoutOut, {
    jobId: 'layout', log, bottomCropPct, padColor,
  });
  return finishPortraitOutput(layoutOut, outputPath, deliveryAspect, log);
}

async function trimSourceRange(inputPath, outputPath, startSec, endSec, log, previewFast = false) {
  const start = Math.max(0, Number(startSec) || 0);
  const end = Math.max(start + 0.04, Number(endSec) || start + 1);
  const dur = end - start;
  const enc = previewFast
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
  // Keep audio — timed layout previously used -an, which silenced the whole Short
  // after multi-segment concat (source still had audio; layout parts did not).
  const run = (args) => new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: previewFast ? 120000 : 600_000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  try {
    await run([
      '-ss', String(start),
      '-i', inputPath,
      '-t', String(dur),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      ...enc,
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      '-y', outputPath,
    ]);
  } catch (_) {
    await run([
      '-ss', String(start),
      '-i', inputPath,
      '-t', String(dur),
      '-an',
      ...enc,
      '-movflags', '+faststart',
      '-y', outputPath,
    ]);
    if (log) log(`[layout] trim slice has no usable audio — video only (${path.basename(outputPath)})`);
  }
  if (log) log(`[layout] trimmed ${start.toFixed(2)}–${end.toFixed(2)}s → ${path.basename(outputPath)}`);
}

async function concatPortraitParts(partPaths, outputPath, log) {
  if (!partPaths.length) throw new Error('concatPortraitParts: no parts');
  if (partPaths.length === 1) {
    fs.copyFileSync(partPaths[0], outputPath);
    return outputPath;
  }
  const listPath = `${outputPath}.parts.txt`;
  fs.writeFileSync(
    listPath,
    partPaths.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n'),
  );
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath(), [
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy',
      '-y', outputPath,
    ], { timeout: 600_000 }, (err) => {
      try { fs.unlinkSync(listPath); } catch (_) { /* ignore */ }
      if (err) reject(err);
      else resolve();
    });
  });
  if (log) log(`[layout] concatenated ${partPaths.length} temporal layout segment(s)`);
  return outputPath;
}

/**
 * Apply different portrait layouts over time ranges within one source clip.
 */
async function applyPortraitLayoutTimed(inputPath, outputPath, {
  compCreative = null,
  trimStart = 0,
  trimEnd,
  layoutSegments = [],
  openingLayout = null,
  deliveryAspect = '9:16',
  sourceFilePreTrimmed = false,
  log = null,
} = {}) {
  const {
    buildLayoutTimePlan,
    mergeCreativeForSegment,
    normalizeLayoutBreakpoints,
  } = require('./composition_layout_segments');

  const start = Math.max(0, Number(trimStart) || 0);
  const end = trimEnd != null ? Number(trimEnd) : start + 60;
  const breakpoints = normalizeLayoutBreakpoints(layoutSegments, { trimStart: start, trimEnd: end });

  // No mid-clip switches: still honor openingLayout (Save look here at Mark In only).
  // Falling through to raw compCreative drops operator full-bleed / focus (CPD-1242).
  if (!breakpoints.length) {
    if (openingLayout && openingLayout.mode) {
      const segCreative = mergeCreativeForSegment(compCreative, openingLayout);
      const { mode, facecamRect } = await resolveEffectiveLayoutMode(inputPath, segCreative, log);
      if (log) log(`[layout] openingLayout-only → ${mode}`);
      return applyPortraitLayout(inputPath, outputPath, {
        compCreative: segCreative,
        log,
        effectiveMode: mode,
        facecamRect,
        deliveryAspect,
      });
    }
    return applyPortraitLayout(inputPath, outputPath, { compCreative, log, deliveryAspect });
  }

  const planStart = sourceFilePreTrimmed ? 0 : start;
  const planEnd = sourceFilePreTrimmed ? Math.max(0.04, end - start) : end;
  const planSegments = sourceFilePreTrimmed
    ? breakpoints.map((b) => ({ ...b, atSec: b.atSec - start }))
    : breakpoints;

  let plan = buildLayoutTimePlan({
    trimStart: planStart,
    trimEnd: planEnd,
    layoutSegments: planSegments,
    openingLayout,
    compCreative,
  });
  // CPD-1279: smooth zoom/centre ramps between full-bleed looks (CapCut-style).
  try {
    const { expandZoomRamps } = require('./zoom_keyframes');
    const expanded = expandZoomRamps(plan);
    if (expanded.length > plan.length && log) {
      log(`[layout] CPD-1279 zoom ramps: ${plan.length} → ${expanded.length} segment(s)`);
    }
    plan = expanded;
  } catch (e) {
    if (log) log(`[layout] zoom ramp expand skipped: ${e.message}`);
  }
  if (plan.length <= 1) {
    const segCreative = mergeCreativeForSegment(compCreative, plan[0]?.layout || openingLayout || {});
    const { mode, facecamRect } = await resolveEffectiveLayoutMode(inputPath, segCreative, log);
    return applyPortraitLayout(inputPath, outputPath, {
      compCreative: segCreative,
      log,
      effectiveMode: mode,
      facecamRect,
      deliveryAspect,
    });
  }

  const tmpStem = `${outputPath}.layoutseg`;
  const parts = [];
  const previewFast = !!compCreative?.previewFast;
  for (let i = 0; i < plan.length; i++) {
    const range = plan[i];
    const sliceIn = `${tmpStem}_${i}_in.mp4`;
    const sliceOut = `${tmpStem}_${i}_out.mp4`;
    const sliceStart = sourceFilePreTrimmed ? range.startSec : range.startSec;
    const sliceEnd = sourceFilePreTrimmed ? range.endSec : range.endSec;
    await trimSourceRange(inputPath, sliceIn, sliceStart, sliceEnd, log, previewFast);
    const segCreative = mergeCreativeForSegment(compCreative, range.layout);
    const { mode, facecamRect } = await resolveEffectiveLayoutMode(sliceIn, segCreative, log);
    if (log) {
      log(`[layout] segment ${i + 1}/${plan.length}: ${range.startSec.toFixed(1)}–${range.endSec.toFixed(1)}s → ${mode}`);
    }
    await applyPortraitLayout(sliceIn, sliceOut, {
      compCreative: { ...segCreative, previewFast },
      log,
      effectiveMode: mode,
      facecamRect,
      deliveryAspect,
    });
    parts.push(sliceOut);
    try { fs.unlinkSync(sliceIn); } catch (_) { /* ignore */ }
  }
  await concatPortraitParts(parts, outputPath, log);
  for (const p of parts) {
    try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
  }
  return outputPath;
}

function buildClipCompLogoFilter(compCreative, logoPath) {
  const { CONFIG } = require('./config');
  const logoMode = resolveLogoMode(compCreative);
  if (logoMode === 'off') return null;

  const clipCompLogo = CONFIG.VISUAL_LAYOUTS.SHORT_FORM.CLIP_COMP_LOGO;
  const shortLogoPos = CONFIG.VISUAL_LAYOUTS.SHORT_FORM.LOGO_POS;

  if (logoMode === 'corner' || ['full_bleed_crop', 'split_screen'].includes(resolveLayoutMode(compCreative))) {
    const size = shortLogoPos?.size || 120;
    const margin = 20;
    const corner = resolveLogoCorner(compCreative);
    const overlayPos = corner === 'top_right'
      ? `x=W-w-${margin}:y=${margin}`
      : `x=W-w-${margin}:y=H-h-${margin}`;
    return `[1:v]scale=${size}:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=${overlayPos}:format=auto,format=yuv420p[vout]`;
  }

  return `[1:v]scale=w='min(${clipCompLogo.maxWidth}\\,iw*${clipCompLogo.maxHeight}/ih)':h='min(${clipCompLogo.maxHeight}\\,ih*${clipCompLogo.maxWidth}/iw)':force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=${clipCompLogo.opacity}[logo];[0:v][logo]overlay=x=(W-w)/2:y=(${clipCompLogo.topBlurBand}-h)/2:format=auto,format=yuv420p[vout]`;
}

module.exports = {
  FULL_BLEED_FILTER,
  SPLIT_TOP_HEIGHT,
  SPLIT_OUTPUT_HEIGHT,
  SPLIT_OUTPUT_WIDTH,
  SOURCE_LANDSCAPE_ASPECT,
  splitPaneNormAspect,
  resolveSplitTopHeight,
  buildFullBleedFilter,
  clampCropZoom,
  resolveFullBleedSourceRect,
  FULL_BLEED_PORTRAIT_W_FRAC,
  buildSplitScreenFilter,
  insetFacecamAwayFromTopChrome,
  insetRectAwayFromTopChrome,
  insetRectAwayFromDesktopChrome,
  resolveTopChromeSafe,
  resolveBottomChromeSafe,
  resolveDesktopChromeInsets,
  TOP_CHROME_SAFE,
  TOP_CHROME_SAFE_DESKTOP,
  BOTTOM_CHROME_SAFE,
  BOTTOM_CHROME_SAFE_DESKTOP,
  BOTTOM_PANE_TOP_EXTRA,
  SOURCE_EDGE_TRIM,
  normalizeFacecamRect,
  defaultLandscapeFacecamRect,
  resolveLandscapeSplitFacecam,
  resolveFullBleedSubject,
  resolveSplitScreenFacecam,
  probeVideoDimensions,
  resolveEffectiveLayoutMode,
  applyPortraitSplitScreen,
  resolveLayoutMode,
  resolveSourceBottomCropPct,
  resolveLogoMode,
  resolveLogoCorner,
  collectLayoutModesFromClips,
  layoutModesNeedCornerLogo,
  coerceLogoCreativeForOutput,
  resolveHookSharpBottom,
  resolveHookPlacement,
  resolveHookMidY,
  layoutFilterDescription,
  applyPortraitLayout,
  applyPortraitLayoutTimed,
  applySquareCrop,
  SQUARE_FILTER,
  applyPortraitFullBleed,
  buildClipCompLogoFilter,
};
