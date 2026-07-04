'use strict';
/**
 * lib/clip_comp_layout.js — portrait layout modes for clip comps (CPD-1089)
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');

const FULL_BLEED_FILTER =
  'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p';

/**
 * Full-bleed crop with optional subject-centred offset (CPD-1227).
 * cx/cy are normalised [0,1] subject centre — the 1080×1920 crop window slides
 * toward the subject instead of always taking the frame centre (which, on
 * desktop-capture clips, keeps a static UI region and crops the facecam out).
 * x/y are even-aligned for yuv420p. null/centre → identical to FULL_BLEED_FILTER.
 */
function buildFullBleedFilter(subjectCx = null, subjectCy = null) {
  const cx = subjectCx == null ? NaN : Number(subjectCx);
  const cy = subjectCy == null ? NaN : Number(subjectCy);
  const hasCx = Number.isFinite(cx) && Math.abs(cx - 0.5) > 0.01;
  const hasCy = Number.isFinite(cy) && Math.abs(cy - 0.5) > 0.01;
  if (!hasCx && !hasCy) return FULL_BLEED_FILTER;
  const clamp = (v) => Math.max(0, Math.min(1, v)).toFixed(3);
  const x = hasCx ? `trunc((iw-1080)*${clamp(cx)}/2)*2` : '(iw-1080)/2';
  const y = hasCy ? `trunc((ih-1920)*${clamp(cy)}/2)*2` : '(ih-1920)/2';
  return `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:${x}:${y},format=yuv420p`;
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
  // Full-bleed single-clip: upper-mid — clears Shorts/TikTok bottom UI (~22%)
  const mode = effectiveMode || resolveLayoutMode(compCreative);
  if (mode === 'full_bleed_crop') return 620;
  // Split: hook rides just below the cam/content seam
  if (mode === 'split_screen') return SPLIT_TOP_HEIGHT + 24;
  return 680;
}

function layoutFilterDescription(mode) {
  if (mode === 'full_bleed_crop') return FULL_BLEED_FILTER;
  if (mode === 'split_screen') return 'facecam split (cam pane top, full-bleed content pane bottom, vstack)';
  return 'blur-pad (smart-crop foreground + blurred background)';
}

async function applyPortraitFullBleed(inputPath, outputPath, {
  log = null,
  bottomCropPct = 0,
  subjectCx = null,
  subjectCy = null,
} = {}) {
  const cropPct = Math.max(0, Math.min(0.3, Number(bottomCropPct) || 0));
  const preCrop = cropPct > 0
    ? `crop=iw:trunc(ih*${(1 - cropPct).toFixed(3)}/2)*2:0:0,`
    : '';
  const filter = buildFullBleedFilter(subjectCx, subjectCy);
  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-vf', `${preCrop}${filter}`,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  if (log) {
    const cxNote = filter === FULL_BLEED_FILTER ? '' : ` (subject cx=${Number(subjectCx).toFixed(2)})`;
    log(`[layout] full-bleed crop applied${cxNote}${cropPct > 0 ? ` (bottom crop ${(cropPct * 100).toFixed(0)}%)` : ''}`);
  }
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
  if (Number.isFinite(overrideCx) || Number.isFinite(overrideCy)) {
    if (log) log(`[layout] full-bleed operator crop override cx=${overrideCx} cy=${overrideCy}`);
    return {
      subjectCx: Number.isFinite(overrideCx) ? overrideCx : null,
      subjectCy: Number.isFinite(overrideCy) ? overrideCy : null,
    };
  }
  try {
    const { detectSubjectCentre } = require('./services/smart_crop');
    const centre = await detectSubjectCentre(inputPath, 'full_bleed');
    if (centre) return { subjectCx: centre.cx, subjectCy: centre.cy };
  } catch { /* centre fallback */ }
  return { subjectCx: null, subjectCy: null };
}

// ─── Split-screen layout — facecam top / content bottom (CPD-1228) ────────────

/** Facecam pane height (px). Content pane gets the remaining 1920−top. */
const SPLIT_TOP_HEIGHT = 640;

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
 * @param {{topHeight?:number, contentCx?:number|null, bottomCropPct?:number}} opts
 * @returns {string} filter_complex ending in [vout]
 */
function buildSplitScreenFilter(facecamRect, { topHeight = SPLIT_TOP_HEIGHT, contentCx = null, bottomCropPct = 0 } = {}) {
  const rect = normalizeFacecamRect(facecamRect);
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

  const ccx = contentCx == null ? NaN : Number(contentCx);
  const xExpr = Number.isFinite(ccx) && Math.abs(ccx - 0.5) > 0.01
    ? `trunc((iw-1080)*${Math.max(0, Math.min(1, ccx)).toFixed(3)}/2)*2`
    : '(iw-1080)/2';

  return [
    `[0:v]split=2[camsrc][contentsrc]`,
    `[camsrc]${camCrop},scale=1080:${top}:force_original_aspect_ratio=increase,crop=1080:${top},setsar=1[top]`,
    `[contentsrc]${contentPre}scale=1080:${bot}:force_original_aspect_ratio=increase,crop=1080:${bot}:${xExpr}:(ih-${bot})/2,setsar=1[bot]`,
    `[top][bot]vstack=inputs=2,format=yuv420p[vout]`,
  ].join(';');
}

async function applyPortraitSplitScreen(inputPath, outputPath, {
  facecamRect,
  log = null,
  bottomCropPct = 0,
  contentCx = null,
  topHeight = SPLIT_TOP_HEIGHT,
} = {}) {
  const filter = buildSplitScreenFilter(facecamRect, { topHeight, contentCx, bottomCropPct });
  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-filter_complex', filter,
      '-map', '[vout]', '-map', '0:a?',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  if (log) {
    const r = normalizeFacecamRect(facecamRect);
    log(`[layout] facecam split applied (cam x=${r.x.toFixed(2)} y=${r.y.toFixed(2)} w=${r.w.toFixed(2)} h=${r.h.toFixed(2)})`);
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

/**
 * Apply blur-pad or full-bleed portrait layout from compCreative profile.
 */
async function applyPortraitLayout(inputPath, outputPath, {
  compCreative = null,
  log = null,
  effectiveMode = null,
  facecamRect: presetFacecam = null,
} = {}) {
  let mode = effectiveMode;
  let cachedFacecam = presetFacecam;
  if (!mode) {
    const resolved = await resolveEffectiveLayoutMode(inputPath, compCreative, log);
    mode = resolved.mode;
    cachedFacecam = resolved.facecamRect;
  }
  const bottomCropPct = resolveSourceBottomCropPct(compCreative);
  if (mode === 'split_screen') {
    const rect = cachedFacecam || await resolveLandscapeSplitFacecam(inputPath, compCreative, log);
    if (rect) {
      const contentCx = Number(compCreative?.layout?.contentCx);
      return applyPortraitSplitScreen(inputPath, outputPath, {
        facecamRect: rect,
        log,
        bottomCropPct,
        contentCx: Number.isFinite(contentCx) ? contentCx : null,
      });
    }
    if (log) log('[layout] split-screen: no facecam detected — falling back to blur-pad');
  }
  if (mode === 'full_bleed_crop') {
    const { subjectCx, subjectCy } = await resolveFullBleedSubject(inputPath, compCreative, log);
    return applyPortraitFullBleed(inputPath, outputPath, { log, bottomCropPct, subjectCx, subjectCy });
  }
  const { applyPortraitBlurPad } = require('./assembly_postprocess');
  return applyPortraitBlurPad(inputPath, outputPath, { jobId: 'layout', log, bottomCropPct });
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
  buildFullBleedFilter,
  buildSplitScreenFilter,
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
  resolveHookSharpBottom,
  resolveHookPlacement,
  resolveHookMidY,
  layoutFilterDescription,
  applyPortraitLayout,
  applyPortraitFullBleed,
  buildClipCompLogoFilter,
};
