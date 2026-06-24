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

/** Bottom Y of the sharp footage zone for hook drawtext (blur-pad vs full bleed). */
function resolveHookSharpBottom(compCreative) {
  if (resolveLayoutMode(compCreative) === 'full_bleed_crop') return 1920;
  const { CONFIG } = require('./config');
  return CONFIG.VISUAL_LAYOUTS?.SHORT_FORM?.CLIP_COMP_SHARP_BOTTOM || 1264;
}

function layoutFilterDescription(mode) {
  if (mode === 'full_bleed_crop') return FULL_BLEED_FILTER;
  return 'blur-pad (smart-crop foreground + blurred background)';
}

async function applyPortraitFullBleed(inputPath, outputPath, { log = null } = {}) {
  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', inputPath,
      '-vf', FULL_BLEED_FILTER,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], { maxBuffer: 50 * 1024 * 1024 }, (err) => (err ? rej(err) : res()));
  });
  if (log) log(`[layout] full-bleed crop applied`);
  return outputPath;
}

/**
 * Apply blur-pad or full-bleed portrait layout from compCreative profile.
 */
async function applyPortraitLayout(inputPath, outputPath, { compCreative = null, log = null } = {}) {
  const mode = resolveLayoutMode(compCreative);
  if (mode === 'full_bleed_crop') {
    return applyPortraitFullBleed(inputPath, outputPath, { log });
  }
  const { applyPortraitBlurPad } = require('./assembly_postprocess');
  return applyPortraitBlurPad(inputPath, outputPath, { jobId: 'layout', log });
}

function buildClipCompLogoFilter(compCreative, logoPath) {
  const { CONFIG } = require('./config');
  const logoMode = resolveLogoMode(compCreative);
  if (logoMode === 'off') return null;

  const clipCompLogo = CONFIG.VISUAL_LAYOUTS.SHORT_FORM.CLIP_COMP_LOGO;
  const shortLogoPos = CONFIG.VISUAL_LAYOUTS.SHORT_FORM.LOGO_POS;

  if (logoMode === 'corner' || resolveLayoutMode(compCreative) === 'full_bleed_crop') {
    const size = shortLogoPos?.size || 120;
    return `[1:v]scale=${size}:-1,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=x=${shortLogoPos?.x || 20}:y=${shortLogoPos?.y || 20}:format=auto,format=yuv420p[vout]`;
  }

  return `[1:v]scale=w='min(${clipCompLogo.maxWidth}\\,iw*${clipCompLogo.maxHeight}/ih)':h='min(${clipCompLogo.maxHeight}\\,ih*${clipCompLogo.maxWidth}/iw)':force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=${clipCompLogo.opacity}[logo];[0:v][logo]overlay=x=(W-w)/2:y=(${clipCompLogo.topBlurBand}-h)/2:format=auto,format=yuv420p[vout]`;
}

module.exports = {
  FULL_BLEED_FILTER,
  resolveLayoutMode,
  resolveLogoMode,
  resolveHookSharpBottom,
  layoutFilterDescription,
  applyPortraitLayout,
  applyPortraitFullBleed,
  buildClipCompLogoFilter,
};
