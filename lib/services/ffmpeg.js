'use strict';
/**
 * lib/services/ffmpeg.js — FFmpeg service for AuraFlux C1+.
 *
 * Re-exports all utilities from lib/ffmpeg_utils.js and adds:
 *   - `run(args, opts)` — Promise wrapper around execFile(ffmpegPath())
 *   - `probe(filePath)` — Promise wrapper to get video duration/metadata
 *   - `isAvailable()` — health-check helper
 *
 * New C1+ code should import from here instead of lib/ffmpeg_utils directly,
 * so the binary path and error handling are consistent.
 *
 * Usage:
 *   const ffmpeg = require('./services/ffmpeg');
 *   const duration = await ffmpeg.probe(filePath);
 *   await ffmpeg.run(['-y', '-i', input, '-c:v', 'copy', output]);
 */

const { execFile, exec } = require('child_process');
const path = require('path');

const {
  ffmpegPath,
  ffprobePath,
  buildProbeCommand,
  buildScaleCommand,
  buildConcatCommand,
  buildOverlayCommand,
  buildAudioMixCommand,
  buildThumbnailCommand,
} = require('../ffmpeg_utils');

// ── Promise wrappers ──────────────────────────────────────────────────────────

/**
 * Run an FFmpeg command and return a Promise.
 * Rejects with the stderr output on non-zero exit.
 *
 * @param {string[]} args        — FFmpeg CLI args (no leading 'ffmpeg')
 * @param {Object}   [opts]
 * @param {number}   [opts.maxBuffer=100MB]
 * @param {number}   [opts.timeout=0]       — ms, 0 = no timeout
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function run(args, opts = {}) {
  const maxBuffer = opts.maxBuffer || 100 * 1024 * 1024;
  const timeout   = opts.timeout   || 0;

  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { maxBuffer, timeout }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Probe a video file and return its duration in seconds.
 * Uses ffprobe — faster than spawning full FFmpeg for metadata.
 *
 * @param {string} filePath
 * @returns {Promise<number>} duration in seconds
 */
function probe(filePath) {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    filePath,
  ];
  return new Promise((resolve, reject) => {
    execFile(ffprobePath(), args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const dur = parseFloat(stdout.trim());
      if (isNaN(dur)) return reject(new Error(`Could not parse duration from: ${stdout.trim()}`));
      resolve(dur);
    });
  });
}

/**
 * Returns true if the FFmpeg binary is reachable.
 * Used in /health checks.
 * @returns {Promise<boolean>}
 */
function isAvailable() {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ['-version'], { timeout: 5000 }, (err) => resolve(!err));
  });
}

// ── Re-exports from ffmpeg_utils ──────────────────────────────────────────────

module.exports = {
  run,
  probe,
  isAvailable,
  ffmpegPath,
  ffprobePath,
  buildProbeCommand,
  buildScaleCommand,
  buildConcatCommand,
  buildOverlayCommand,
  buildAudioMixCommand,
  buildThumbnailCommand,
};
