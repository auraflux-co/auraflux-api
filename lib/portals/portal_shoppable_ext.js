'use strict';
/**
 * portal_shoppable_ext — Shoppable video extension (CPD-120)
 *
 * Fires after Portal 4 (assembly), before Portal 5 (publish).
 * Bakes a CTA text overlay into the assembled video using FFmpeg,
 * then updates jobSpec.assembledPath to the shoppable output.
 *
 * Job spec shape expected:
 *   jobSpec.assembledPath              — path to the assembled video
 *   jobSpec.addOns.shoppable.active    — true to run this extension
 *   jobSpec.addOns.shoppable.ctaText   — CTA text (default: "Tap to shop")
 *   jobSpec.addOns.shoppable.startSec  — when CTA appears (default: 3)
 *   jobSpec.addOns.shoppable.endSec    — when CTA disappears (default: video end - 2)
 *   jobSpec.addOns.shoppable.position  — 'bottom' | 'top-right' (default: 'bottom')
 */

const path   = require('path');
const fs     = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { logError } = require('../error_logger');
const { isFeatureEnabled } = require('../services/feature_gate');

// ── Helpers ────────────────────────────────────────────────────────────────────

function ffmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/**
 * Build the FFmpeg drawtext filter for the CTA overlay.
 *
 * @param {string} text
 * @param {'bottom'|'top-right'} position
 * @param {number} startSec
 * @param {number|null} endSec
 * @returns {string}  FFmpeg filter string
 */
function buildDrawtextFilter(text, position, startSec, endSec) {
  const escaped = text.replace(/'/g, "\\'").replace(/:/g, '\\:');
  const posX = position === 'top-right' ? 'W-tw-40' : '(W-tw)/2';
  const posY = position === 'top-right' ? '40'       : 'H-th-40';
  const enable = endSec
    ? `between(t,${startSec},${endSec})`
    : `gte(t,${startSec})`;

  return (
    `drawtext=text='${escaped}'` +
    `:x=${posX}:y=${posY}` +
    `:fontsize=36:fontcolor=white` +
    `:box=1:boxcolor=black@0.55:boxborderw=14` +
    `:enable='${enable}'`
  );
}

// ── Worker ─────────────────────────────────────────────────────────────────────

async function runWorker({ jobSpec, workerAttempt = 1 } = {}) {
  const jobId = jobSpec?.jobId || 'unknown';

  if (!isFeatureEnabled('portal.shoppable', jobSpec?.planTier)) {
    return { passed: true, outcome: 'skip', reason: 'portal.shoppable not enabled for plan' };
  }

  if (!jobSpec?.addOns?.shoppable?.active) {
    return {
      passed:  true,
      outcome: 'skip',
      reason:  'Shoppable add-on not ordered for this job',
    };
  }

  const inputPath = jobSpec.assembledPath || jobSpec.outputPath;
  if (!inputPath || !fs.existsSync(inputPath)) {
    return {
      passed:  false,
      outcome: 'hard_fail',
      reason:  `Shoppable ext: assembled video not found at ${inputPath || '(undefined)'}`,
    };
  }

  const {
    ctaText  = 'Tap to shop',
    startSec = 3,
    endSec   = null,
    position = 'bottom',
  } = jobSpec.addOns.shoppable;

  const dir      = path.dirname(inputPath);
  const base     = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(dir, `${base}-shoppable${path.extname(inputPath)}`);

  const filter = buildDrawtextFilter(ctaText, position, startSec, endSec);

  const ffmpegArgs = [
    '-y',
    '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'fast',
    '-c:a', 'copy',
    outputPath,
  ];

  try {
    await execFileAsync(ffmpegPath(), ffmpegArgs, { timeout: 300_000 });
  } catch (err) {
    logError('SHOPPABLE_FFMPEG_FAIL', err, { jobId, inputPath });
    return {
      passed:  false,
      outcome: 'hard_fail',
      reason:  `Shoppable FFmpeg overlay failed: ${err.message}`,
    };
  }

  if (!fs.existsSync(outputPath)) {
    return {
      passed:  false,
      outcome: 'hard_fail',
      reason:  `Shoppable output file not created at ${outputPath}`,
    };
  }

  // Mutate jobSpec so portal5 picks up the shoppable-tagged video
  jobSpec.assembledPath = outputPath;

  console.log(`[shoppable-ext:${jobId}] CTA overlay applied → ${outputPath}`);

  return {
    passed:     true,
    outcome:    'cta_baked',
    outputPath,
    ctaText,
    position,
  };
}

function isPass(result) {
  return result?.passed === true || result?.outcome === 'skip';
}

module.exports = { runWorker, isPass };
