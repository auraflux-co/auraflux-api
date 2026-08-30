'use strict';

/**
 * CPD-1282 — Beat / energy peak detect for Compose punch/shake suggestions.
 * Uses PCM RMS energy (no extra deps). Feature key: ai.beat_sync.
 */

const path = require('path');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Decode mono s16le PCM at sampleRate via ffmpeg stdout.
 */
function decodePcm(filePath, { sampleRate = 8000, maxSec = 120 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', filePath,
      '-t', String(maxSec),
      '-vn', '-ac', '1', '-ar', String(sampleRate),
      '-f', 's16le', 'pipe:1',
    ];
    const child = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (!chunks.length) {
        reject(new Error(`beat_detect: no audio (${stderr.slice(-200) || `exit ${code}`})`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Find local energy peaks in PCM.
 * @returns {Array<{atSec:number,score:number}>}
 */
function peaksFromPcm(pcm, {
  sampleRate = 8000,
  hopSec = 0.05,
  windowSec = 0.1,
  minGapSec = 0.85,
  maxPeaks = 8,
  thresholdRatio = 1.35,
} = {}) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  if (samples.length < sampleRate * 0.3) return [];

  const hop = Math.max(1, Math.round(sampleRate * hopSec));
  const win = Math.max(hop, Math.round(sampleRate * windowSec));
  const energies = [];
  for (let i = 0; i + win < samples.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const v = samples[i + j] / 32768;
      sum += v * v;
    }
    energies.push({
      atSec: (i + win / 2) / sampleRate,
      rms: Math.sqrt(sum / win),
    });
  }
  if (energies.length < 4) return [];

  const mean = energies.reduce((a, e) => a + e.rms, 0) / energies.length;
  const threshold = mean * thresholdRatio;
  const candidates = [];
  for (let i = 1; i < energies.length - 1; i++) {
    const e = energies[i];
    if (e.rms < threshold) continue;
    if (e.rms < energies[i - 1].rms || e.rms < energies[i + 1].rms) continue;
    candidates.push({ atSec: Math.round(e.atSec * 100) / 100, score: e.rms / (mean || 1e-6) });
  }
  candidates.sort((a, b) => b.score - a.score);

  const picked = [];
  for (const c of candidates) {
    if (picked.length >= maxPeaks) break;
    if (picked.some((p) => Math.abs(p.atSec - c.atSec) < minGapSec)) continue;
    // Skip very start (often intro silence→speech)
    if (c.atSec < 0.35) continue;
    picked.push(c);
  }
  picked.sort((a, b) => a.atSec - b.atSec);
  return picked;
}

/**
 * Map peaks → zoom_punch + camera_shake configs for Compose / assembly.
 */
function suggestionsFromPeaks(peaks, {
  punchZoom = 1.28,
  punchDuration = 0.35,
  shakeIntensity = 1.1,
  shakeDuration = 0.28,
} = {}) {
  const list = Array.isArray(peaks) ? peaks : [];
  const punches = list.map((p) => ({
    atSec: p.atSec,
    zoom: punchZoom,
    duration: punchDuration,
    cx: 0.5,
    cy: 0.45,
  }));
  const shakes = list.map((p, i) => ({
    atSec: p.atSec,
    duration: shakeDuration,
    intensity: clamp(shakeIntensity * Math.min(1.4, p.score / 2), 0.4, 2.2, 1),
    seed: i * 5 + 1,
  }));
  const cutMarks = list.map((p) => ({ atSec: p.atSec, kind: 'beat' }));
  // Gemini Core_fx + still QA: longer/stronger flashes so frame samples can catch them.
  const flashes = list.map((p) => ({
    atSec: p.atSec,
    duration: 0.7,
    strength: Math.min(0.45, 0.28 + (p.score || 1) * 0.05),
  }));
  // CPD-1286: highlight SFX drops on the same peaks
  const { sfxDropsFromPeaks } = require('./highlight_sfx');
  const highlightSfx = sfxDropsFromPeaks(list);
  return {
    zoomPunch: punches.length ? { enabled: true, punches } : null,
    cameraShake: shakes.length ? { enabled: true, shakes } : null,
    impactTint: flashes.length ? { enabled: true, flashes } : null,
    highlightSfx: highlightSfx.drops.length ? highlightSfx : null,
    cutMarks,
  };
}

async function analyzeBeatsOnFile(filePath, opts = {}) {
  const sampleRate = 8000;
  const pcm = await decodePcm(filePath, {
    sampleRate,
    maxSec: clamp(opts.maxSec, 10, 180, 90),
  });
  const peaks = peaksFromPcm(pcm, {
    sampleRate,
    hopSec: opts.hopSec,
    windowSec: opts.windowSec,
    minGapSec: opts.minGapSec,
    maxPeaks: opts.maxPeaks != null ? opts.maxPeaks : 6,
    thresholdRatio: opts.thresholdRatio,
  });
  const suggestions = suggestionsFromPeaks(peaks, opts);
  return {
    peaks,
    ...suggestions,
    peakCount: peaks.length,
    source: opts.sourceLabel || 'file',
  };
}

/**
 * CPD-1286 — analyze the selected music bed (not clip audio) for Beats→FX.
 */
/** In-memory cache — music beds are static assets; Gap fixes re-hits the same bed often. */
const _musicBedBeatCache = new Map();

function musicBedCacheKey(musicBedKey, opts = {}) {
  const maxSec = opts.maxSec != null ? opts.maxSec : 20;
  const maxPeaks = opts.maxPeaks != null ? opts.maxPeaks : 6;
  return `${String(musicBedKey || '')}|${maxSec}|${maxPeaks}`;
}

async function analyzeBeatsOnMusicBed(musicBedKey, opts = {}) {
  const { resolveBedPath } = require('./clip_comp_audio_mix');
  const bedPath = resolveBedPath(musicBedKey);
  if (!bedPath) {
    throw new Error(`Music bed not found: ${musicBedKey || '(empty)'}`);
  }
  // Compose Shorts only need peaks in the trim window — default 20s (was 45–90).
  const maxSec = opts.maxSec != null ? clamp(opts.maxSec, 8, 60, 20) : 20;
  const cacheKey = musicBedCacheKey(musicBedKey, { ...opts, maxSec });
  if (!opts.noCache && _musicBedBeatCache.has(cacheKey)) {
    const hit = _musicBedBeatCache.get(cacheKey);
    return { ...hit, cached: true };
  }
  const result = await analyzeBeatsOnFile(bedPath, {
    ...opts,
    maxSec,
    sourceLabel: `music_bed:${path.basename(bedPath)}`,
  });
  const out = { ...result, bedPath, musicBed: musicBedKey, cached: false };
  _musicBedBeatCache.set(cacheKey, out);
  // Bound memory — beds are few; keep last 24 analyses
  if (_musicBedBeatCache.size > 24) {
    const first = _musicBedBeatCache.keys().next().value;
    _musicBedBeatCache.delete(first);
  }
  return out;
}

module.exports = {
  decodePcm,
  peaksFromPcm,
  suggestionsFromPeaks,
  analyzeBeatsOnFile,
  analyzeBeatsOnMusicBed,
};
