'use strict';
/**
 * Post-process EchoMimic avatar plates before assembly (CPD-991).
 * C0-only — hides residual hand artifacts via center crop when enabled.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORTRAIT_KEYS = {
  heygen_frame: 'spike/cpd881/inputs/bobbyg_heygen_frame.png',
  head_only: 'spike/cpd881/inputs/bobbyg_head_only.png',
  tight_head: 'spike/cpd881/inputs/bobbyg_tight_head.png',
  mouth_focus: 'spike/cpd881/inputs/bobbyg_mouth_focus.png',
  baseline_head: 'spike/cpd881/inputs/bobbyg_baseline_head.png'
};

function resolvePortraitKey() {
  if (process.env.ECHOMIMIC_IMAGE_KEY) return process.env.ECHOMIMIC_IMAGE_KEY;
  const preset = String(process.env.ECHOMIMIC_PORTRAIT || 'heygen_frame').toLowerCase();
  return PORTRAIT_KEYS[preset] || PORTRAIT_KEYS.heygen_frame;
}

function isHeadPortraitKey(key) {
  return /head_only|tight_head|baseline_head|mouth_focus/i.test(String(key || ''));
}

function assemblyCropEnabled() {
  return String(process.env.ECHOMIMIC_ASSEMBLY_CROP || 'off').toLowerCase() === 'on';
}

function assemblyCropFilter() {
  return process.env.ECHOMIMIC_ASSEMBLY_CROP_FILTER
    || 'crop=960:900:(iw-960)/2:40';
}

/** Apply optional center crop to an avatar segment mp4 (in place or to outPath). */
async function applyAvatarPlateCrop(inPath, outPath = inPath) {
  if (!assemblyCropEnabled() || !fs.existsSync(inPath)) return inPath;
  const vf = `${assemblyCropFilter()},scale=1920:1080:flags=lanczos`;
  const tmp = outPath === inPath ? `${inPath}.crop.mp4` : outPath;
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-i', inPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-c:a', 'copy',
      tmp
    ], (err) => (err ? reject(new Error(`avatar crop failed: ${err.message}`)) : resolve()));
  });
  if (tmp !== outPath) {
    fs.renameSync(tmp, outPath);
  }
  return outPath;
}

module.exports = {
  PORTRAIT_KEYS,
  resolvePortraitKey,
  isHeadPortraitKey,
  assemblyCropEnabled,
  assemblyCropFilter,
  applyAvatarPlateCrop
};
