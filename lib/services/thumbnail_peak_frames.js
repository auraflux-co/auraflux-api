'use strict';

/**
 * Peak-aware thumbnail frame timestamps — audio energy + scene cuts, fallback midpoints.
 * Gate: thumbnail.peak_picker
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { ffmpegPath, ffprobePath } = require('../ffmpeg_utils');

const execFileAsync = promisify(execFile);

async function getDuration(videoPath) {
  const { stdout } = await execFileAsync(ffprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
  ], { timeout: 30000 });
  const d = parseFloat(String(stdout).trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

/** Sample volume every ~0.5s; return top loud moments (seconds). */
async function audioEnergyPeaks(videoPath, duration, maxPeaks = 5) {
  const peaks = [];
  try {
    const { stderr } = await execFileAsync(ffmpegPath(), [
      '-i', videoPath,
      '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-',
    ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    const lines = String(stderr || '').split('\n');
    let t = 0;
    const samples = [];
    for (const line of lines) {
      const pts = line.match(/pts_time:([\d.]+)/);
      if (pts) t = parseFloat(pts[1]);
      const rms = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|inf|-inf)/);
      if (rms && rms[1] !== 'inf' && rms[1] !== '-inf') {
        const level = parseFloat(rms[1]);
        if (Number.isFinite(level)) samples.push({ t, level });
      }
    }
    samples.sort((a, b) => b.level - a.level);
    for (const s of samples) {
      if (s.t < 0.4 || s.t > duration - 0.4) continue;
      if (peaks.some((p) => Math.abs(p - s.t) < 1.2)) continue;
      peaks.push(s.t);
      if (peaks.length >= maxPeaks) break;
    }
  } catch (_) { /* soft-fail */ }
  return peaks;
}

/** Scene-cut timestamps via select=gt(scene). */
async function motionScenePeaks(videoPath, duration, maxPeaks = 5) {
  const peaks = [];
  try {
    const { stderr } = await execFileAsync(ffmpegPath(), [
      '-i', videoPath,
      '-vf', "select='gt(scene,0.35)',showinfo",
      '-f', 'null', '-',
    ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
    const re = /pts_time:([\d.]+)/g;
    let m;
    const text = String(stderr || '');
    while ((m = re.exec(text)) !== null) {
      const t = parseFloat(m[1]);
      if (!Number.isFinite(t) || t < 0.4 || t > duration - 0.4) continue;
      if (peaks.some((p) => Math.abs(p - t) < 1.0)) continue;
      peaks.push(t);
      if (peaks.length >= maxPeaks) break;
    }
  } catch (_) { /* soft-fail */ }
  return peaks;
}

/**
 * Return up to 3 offset seconds for thumbnail candidates.
 * @returns {Promise<Array<{ offsetSeconds: number, score: number, method: string }>>}
 */
async function pickPeakThumbnailOffsets(videoPath, { planTier = 'operate' } = {}) {
  const { isFeatureEnabled } = require('./feature_gate');
  const duration = await getDuration(videoPath);
  if (!duration || duration < 1) return [];

  const fallback = [0.25, 0.5, 0.75].map((pct, i) => ({
    offsetSeconds: Math.max(1, Math.floor(duration * pct)),
    score: 0.55 - i * 0.05,
    method: 'frame_fallback',
  }));

  if (!isFeatureEnabled('thumbnail.peak_picker', planTier)) {
    return fallback.slice(0, 3);
  }

  const [audio, motion] = await Promise.all([
    audioEnergyPeaks(videoPath, duration, 5),
    motionScenePeaks(videoPath, duration, 5),
  ]);

  const scored = [];
  for (const t of audio) {
    scored.push({ offsetSeconds: Math.max(1, Math.round(t * 10) / 10), score: 0.92, method: 'audio_peak' });
  }
  for (const t of motion) {
    if (scored.some((s) => Math.abs(s.offsetSeconds - t) < 0.8)) continue;
    scored.push({ offsetSeconds: Math.max(1, Math.round(t * 10) / 10), score: 0.85, method: 'motion_peak' });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = [];
  for (const s of scored) {
    if (top.some((x) => Math.abs(x.offsetSeconds - s.offsetSeconds) < 1.0)) continue;
    top.push(s);
    if (top.length >= 3) break;
  }

  while (top.length < 3 && fallback.length) {
    const f = fallback.shift();
    if (top.some((x) => Math.abs(x.offsetSeconds - f.offsetSeconds) < 1.0)) continue;
    top.push(f);
  }

  return top.slice(0, 3);
}

module.exports = {
  pickPeakThumbnailOffsets,
  audioEnergyPeaks,
  motionScenePeaks,
};
