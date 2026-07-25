'use strict';

/**
 * CPD-1284 — FFmpeg xfade/acrossfade between portrait clip-comp segments.
 * Hard concat remains the fallback (single clip, style=cut/off, or xfade failure).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { probeDurationSec } = require('./clip_comp_tts');

const PORTRAIT_W = 1080;
const PORTRAIT_H = 1920;

const XFADE_MAP = {
  cut: null,
  off: null,
  none: null,
  hard: null,
  fade: 'fade',
  crossfade: 'fade',
  fade_black: 'fadeblack',
  fadeblack: 'fadeblack',
  wipe_left: 'wipeleft',
  wipeleft: 'wipeleft',
  wipe_right: 'wiperight',
  wiperight: 'wiperight',
  dissolve: 'dissolve',
  slide_left: 'slideleft',
  slideleft: 'slideleft',
};

function resolveTransitionStyle(compCreative) {
  const raw = compCreative?.transition?.style
    || compCreative?.transitions?.style
    || compCreative?.audio?.transitionStyle
    || 'cut';
  const key = String(raw || 'cut').trim().toLowerCase();
  return XFADE_MAP[key] === undefined ? 'fade' : XFADE_MAP[key];
}

function resolveTransitionDuration(compCreative) {
  const d = Number(compCreative?.transition?.durationSec
    ?? compCreative?.transitions?.durationSec
    ?? 0.35);
  if (!Number.isFinite(d)) return 0.35;
  return Math.max(0.12, Math.min(1.2, d));
}

/**
 * Normalize + chain xfade for 9:16 portrait segments.
 * @returns {Promise<string>} outputPath
 */
async function concatPortraitClipsWithTransitions(portraitClips, outputPath, {
  asmId = 'comp',
  tmpDir,
  style = 'fade',
  durationSec = 0.35,
  log = () => {},
} = {}) {
  if (!Array.isArray(portraitClips) || !portraitClips.length) {
    throw new Error('concatPortraitClipsWithTransitions: no clips');
  }
  if (portraitClips.length === 1 || !style) {
    fs.copyFileSync(portraitClips[0], outputPath);
    return outputPath;
  }

  const TRANS_DUR = resolveTransitionDuration({ transition: { durationSec } });
  const transition = String(style);

  let clipDurs;
  try {
    clipDurs = await Promise.all(portraitClips.map((p) => probeDurationSec(p).catch(() => 0)));
  } catch (_) {
    clipDurs = portraitClips.map(() => 0);
  }
  if (clipDurs.some((d) => !(d > TRANS_DUR + 0.05))) {
    throw new Error('clip too short for xfade — use hard concat');
  }

  const inputs = portraitClips.flatMap((p) => ['-i', p]);
  const vFilters = portraitClips.map((_, i) =>
    `[${i}:v]fps=30,setpts=PTS-STARTPTS,scale=${PORTRAIT_W}:${PORTRAIT_H}:force_original_aspect_ratio=increase,` +
    `crop=${PORTRAIT_W}:${PORTRAIT_H},setsar=1,format=yuv420p[nv${i}]`);
  const aFilters = portraitClips.map((_, i) =>
    `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[na${i}]`);

  const xFilters = [];
  const xaFilters = [];
  let vRef = 'nv0';
  let aRef = 'na0';
  let cumDur = clipDurs[0];

  for (let i = 1; i < portraitClips.length; i++) {
    const offset = Math.max(0, cumDur - TRANS_DUR);
    const nextVRef = i < portraitClips.length - 1 ? `xv${i}` : 'vout';
    const nextARef = i < portraitClips.length - 1 ? `xa${i}` : 'aout';
    xFilters.push(
      `[${vRef}][nv${i}]xfade=transition=${transition}:duration=${TRANS_DUR.toFixed(3)}:offset=${offset.toFixed(3)}[${nextVRef}]`,
    );
    xaFilters.push(
      `[${aRef}][na${i}]acrossfade=d=${TRANS_DUR.toFixed(3)}[${nextARef}]`,
    );
    vRef = nextVRef;
    aRef = nextARef;
    cumDur += clipDurs[i] - TRANS_DUR;
  }

  const filterComplex = [...vFilters, ...aFilters, ...xFilters, ...xaFilters].join(';');

  await new Promise((resolve, reject) => {
    execFile(ffmpegPath(), [
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart',
      '-y', outputPath,
    ], { maxBuffer: 80 * 1024 * 1024, timeout: 900000 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });

  log(`  🎞️  Clip-comp xfade=${transition} d=${TRANS_DUR.toFixed(2)}s joins=${portraitClips.length - 1}`);
  return outputPath;
}

module.exports = {
  XFADE_MAP,
  PORTRAIT_W,
  PORTRAIT_H,
  resolveTransitionStyle,
  resolveTransitionDuration,
  concatPortraitClipsWithTransitions,
};
