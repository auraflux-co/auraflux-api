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

function resolveLayoutMode(compCreative) {
  return compCreative?.layout?.mode || 'blur_pad';
}

function resolveLogoMode(compCreative) {
  return compCreative?.layout?.logo || 'top_blur_fold';
}

function resolveLogoCorner(compCreative) {
  const explicit = compCreative?.layout?.logoCorner;
  if (explicit === 'top_right' || explicit === 'bottom_right') return explicit;
  // Full-bleed shorts: logo top-right — hook mid, whisper bottom
  if (resolveLayoutMode(compCreative) === 'full_bleed_crop') return 'top_right';
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
function resolveHookPlacement(compCreative) {
  if (compCreative?.hooks?.rankedList?.enabled) return 'ranked_mid';
  if (resolveLayoutMode(compCreative) === 'full_bleed_crop') return 'full_bleed_mid';
  return 'bottom';
}

function resolveHookMidY(compCreative) {
  const slotCount = compCreative?.hooks?.rankedList?.slotCount || 5;
  if (compCreative?.hooks?.rankedList?.enabled) {
    if (slotCount > 6) return 680;
    return 560 + Math.max(0, 5 - slotCount) * 12;
  }
  // Full-bleed single-clip: upper-mid — clears Shorts/TikTok bottom UI (~22%)
  if (resolveLayoutMode(compCreative) === 'full_bleed_crop') return 620;
  return 680;
}

function layoutFilterDescription(mode) {
  if (mode === 'full_bleed_crop') return FULL_BLEED_FILTER;
  return 'blur-pad (smart-crop foreground + blurred background)';
}

async function applyPortraitFullBleed(inputPath, outputPath, { log = null, bottomCropPct = 0 } = {}) {
  const cropPct = Math.max(0, Math.min(0.3, Number(bottomCropPct) || 0));
  const preCrop = cropPct > 0
    ? `crop=iw:trunc(ih*${(1 - cropPct).toFixed(3)}/2)*2:0:0,`
    : '';
  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-vf', `${preCrop}${FULL_BLEED_FILTER}`,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  if (log) log(`[layout] full-bleed crop applied${cropPct > 0 ? ` (bottom crop ${(cropPct * 100).toFixed(0)}%)` : ''}`);
  return outputPath;
}

/** CPD-1220: baked-in bottom strips (tickers/social bars) cropped off the source pre-layout. */
function resolveSourceBottomCropPct(compCreative) {
  return Math.max(0, Math.min(0.3, Number(compCreative?.layout?.sourceBottomCropPct) || 0));
}

/**
 * Apply blur-pad or full-bleed portrait layout from compCreative profile.
 */
async function applyPortraitLayout(inputPath, outputPath, { compCreative = null, log = null } = {}) {
  const mode = resolveLayoutMode(compCreative);
  const bottomCropPct = resolveSourceBottomCropPct(compCreative);
  if (mode === 'full_bleed_crop') {
    return applyPortraitFullBleed(inputPath, outputPath, { log, bottomCropPct });
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

  if (logoMode === 'corner' || resolveLayoutMode(compCreative) === 'full_bleed_crop') {
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
