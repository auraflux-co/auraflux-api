'use strict';
/**
 * lib/gates/music_preflight.js — CPD-1050
 * Scan clip-comp source segments for dominant music before assembly/publish.
 * Live Grid music guard does not apply to VOD comps (mixMode: source).
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyAudioGemini } = require('../live_grid/music_detector');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SAMPLE_SEC = Number(process.env.C0_MUSIC_PREFLIGHT_SAMPLE_SEC || '4');
const CONFIDENCE_MIN = Number(process.env.C0_MUSIC_PREFLIGHT_CONFIDENCE_MIN || '0.72');

function musicPreflightEnabled() {
  return String(process.env.C0_MUSIC_PREFLIGHT ?? 'on').toLowerCase() !== 'off';
}

function preflightAction() {
  const action = String(process.env.C0_MUSIC_PREFLIGHT_ACTION || 'hold').toLowerCase();
  return ['hold', 'warn', 'mute'].includes(action) ? action : 'hold';
}

function sampleFileAudio(filePath, sampleSec = SAMPLE_SEC) {
  const tmp = path.join(os.tmpdir(), `music_pf_${Date.now()}_${path.basename(filePath)}.mp3`);
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-t', String(sampleSec), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k',
      '-y', tmp,
    ], { timeout: (sampleSec + 12) * 1000 }, (err) => {
      try {
        if (err) throw err;
        const buf = fs.readFileSync(tmp);
        if (!buf.length) throw new Error('empty capture');
        resolve(buf);
      } catch (e) {
        reject(e);
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      }
    });
  });
}

/**
 * @returns {Promise<{ passed: boolean, action: string, flagged: object[], warnings: string[], skipped?: boolean }>}
 */
async function scanClipPathsForMusic(clipPaths = [], opts = {}) {
  const log = opts.log || (() => {});
  const classify = opts.classify || classifyAudioGemini;
  const sample = opts.sample || sampleFileAudio;
  const confidenceMin = opts.confidenceMin ?? CONFIDENCE_MIN;
  const flagged = [];
  const warnings = [];
  const action = preflightAction();

  if (!musicPreflightEnabled()) {
    return { passed: true, action, flagged, warnings, skipped: true };
  }

  for (let i = 0; i < clipPaths.length; i++) {
    const fp = clipPaths[i];
    if (!fp || !fs.existsSync(fp)) {
      warnings.push(`clip ${i + 1}: file missing — skipped`);
      continue;
    }
    try {
      const buf = await sample(fp);
      const res = await classify(buf);
      if (res.music && res.confidence >= confidenceMin) {
        flagged.push({ index: i, path: fp, confidence: res.confidence });
        log(`🎵 clip ${i + 1}: music detected (confidence ${res.confidence.toFixed(2)})`);
      }
    } catch (e) {
      warnings.push(`clip ${i + 1}: scan failed (${e.message}) — fail-open`);
      log(`  ⚠️ music preflight clip ${i + 1} skipped: ${e.message}`);
    }
  }

  const passed = flagged.length === 0 || action === 'warn';
  return { passed, action, flagged, warnings };
}

async function muteClipAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputPath,
      '-c:v', 'copy', '-an',
      '-y', outputPath,
    ], { timeout: 120000 }, (err) => (err ? reject(err) : resolve(outputPath)));
  });
}

module.exports = {
  musicPreflightEnabled,
  preflightAction,
  scanClipPathsForMusic,
  sampleFileAudio,
  muteClipAudio,
  CONFIDENCE_MIN,
};
