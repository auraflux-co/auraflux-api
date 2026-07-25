'use strict';

/**
 * CPD-1280 — Timed camera punch/shake via FFmpeg crop wobble.
 * CapCut-style impact shakes; burns in during portrait assembly.
 */

const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const {
  normalizeZoomPunches,
  buildZoomPunchFilter,
} = require('./zoom_keyframes');

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * @param {object|null} cfg
 * @returns {Array<{atSec:number,duration:number,intensity:number,seed:number}>}
 */
function normalizeShakes(cfg) {
  if (!cfg || cfg.enabled === false) return [];
  const raw = Array.isArray(cfg.shakes) && cfg.shakes.length
    ? cfg.shakes
    : (cfg.atSec != null
      ? [{ atSec: cfg.atSec, duration: cfg.duration, intensity: cfg.intensity }]
      : []);
  return raw.map((s, i) => {
    const atSec = Number(s?.atSec ?? s?.t);
    if (!Number.isFinite(atSec) || atSec < 0) return null;
    return {
      atSec,
      duration: clamp(s.duration, 0.08, 1.5, 0.28),
      intensity: clamp(s.intensity, 0.15, 3, 1),
      seed: Number.isFinite(Number(s.seed)) ? Number(s.seed) : (i * 7 + 3),
    };
  }).filter(Boolean).sort((a, b) => a.atSec - b.atSec);
}

/**
 * Crop wobble during timed windows. Pads by max amplitude so edges never show black.
 * @returns {string|null}
 */
function buildShakeFilter(shakes) {
  const list = Array.isArray(shakes) ? shakes : normalizeShakes(shakes);
  if (!list.length) return null;

  const maxAmp = Math.max(...list.map((s) => Math.ceil(s.intensity * 10)));
  const pad = Math.max(4, Math.min(48, maxAmp + 2));

  let xOsc = '0';
  let yOsc = '0';
  for (const s of list) {
    const amp = Math.max(2, Math.min(40, Math.round(s.intensity * 10)));
    const t0 = s.atSec.toFixed(3);
    const t1 = (s.atSec + s.duration).toFixed(3);
    const fx = (55 + (s.seed % 17)).toFixed(2);
    const fy = (43 + (s.seed % 13)).toFixed(2);
    xOsc += `+if(between(t\\,${t0}\\,${t1})\\,sin(t*${fx})*${amp}\\,0)`;
    yOsc += `+if(between(t\\,${t0}\\,${t1})\\,cos(t*${fy})*${amp}\\,0)`;
  }

  return `crop=iw-${pad * 2}:ih-${pad * 2}:x='${pad}+(${xOsc})':y='${pad}+(${yOsc})',setsar=1,format=yuv420p`;
}

/**
 * Combine optional zoom_punch + camera_shake into one -vf chain.
 */
function buildCameraFxFilter({ zoomPunch = null, cameraShake = null, width = 1080, height = 1920, fps = 30 } = {}) {
  const parts = [];
  const punches = normalizeZoomPunches(zoomPunch);
  if (punches.length) {
    const z = buildZoomPunchFilter(punches, { width, height, fps });
    if (z) parts.push(z);
  }
  const shakes = normalizeShakes(cameraShake);
  const shake = buildShakeFilter(shakes);
  if (shake) parts.push(shake);
  return parts.length ? parts.join(',') : null;
}

function runFfmpeg(args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Apply zoom punch and/or shake to a portrait (or any) clip.
 * @returns {Promise<string>} outputPath
 */
async function applyCameraFx(inputPath, outputPath, {
  zoomPunch = null,
  cameraShake = null,
  width = 1080,
  height = 1920,
  fps = 30,
  previewFast = false,
  log = null,
} = {}) {
  const vf = buildCameraFxFilter({ zoomPunch, cameraShake, width, height, fps });
  if (!vf) {
    const fs = require('fs');
    if (inputPath !== outputPath) fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
  const enc = previewFast
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];
  await runFfmpeg([
    '-i', inputPath,
    '-vf', vf,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    ...enc, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    '-y', outputPath,
  ]);
  if (log) {
    const p = normalizeZoomPunches(zoomPunch).length;
    const s = normalizeShakes(cameraShake).length;
    log(`[camera-fx] CPD-1280 applied (${p} punch(es), ${s} shake(s))`);
  }
  return outputPath;
}

module.exports = {
  normalizeShakes,
  buildShakeFilter,
  buildCameraFxFilter,
  applyCameraFx,
};
