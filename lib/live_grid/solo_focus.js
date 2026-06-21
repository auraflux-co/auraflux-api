'use strict';

/**
 * Solo focus — allocate encode CPU to one YouTube solo seat (hero stream).
 */

const { soloIndex } = require('./solo_listings_env');

function parseFocusSeat() {
  const raw = process.env.LIVE_GRID_SOLO_FOCUS;
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  return n;
}

function soloFocusSeat() {
  return parseFocusSeat();
}

function soloSeatActive(q) {
  const focus = parseFocusSeat();
  if (!focus) return true;
  const i = soloIndex(q);
  return i === focus;
}

function mainGridEncodeEnabled() {
  return String(process.env.LIVE_GRID_MAIN_ENCODE ?? 'on').toLowerCase() !== 'off';
}

function soloSeatEnvKey(q, suffix) {
  const i = soloIndex(q);
  if (!i) return null;
  return `LIVE_GRID_SOLO_${i}_${suffix}`;
}

function readSoloSeatInt(q, suffix, fallback) {
  const key = soloSeatEnvKey(q, suffix);
  if (!key) return fallback;
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

function applySoloSeatEncodeOverrides(q, opts = {}) {
  const i = soloIndex(q);
  if (!i) throw new Error('quadrant must be 0-3');
  if (opts.bitrateK != null) process.env[`LIVE_GRID_SOLO_${i}_BITRATE_K`] = String(opts.bitrateK);
  if (opts.maxrateK != null) process.env[`LIVE_GRID_SOLO_${i}_X264_MAXRATE_K`] = String(opts.maxrateK);
  if (opts.bufsizeK != null) process.env[`LIVE_GRID_SOLO_${i}_X264_BUFSIZE_K`] = String(opts.bufsizeK);
  if (opts.w != null) process.env[`LIVE_GRID_SOLO_${i}_OUTPUT_W`] = String(opts.w);
  if (opts.h != null) process.env[`LIVE_GRID_SOLO_${i}_OUTPUT_H`] = String(opts.h);
  if (opts.fps != null) process.env[`LIVE_GRID_SOLO_${i}_FPS`] = String(opts.fps);
  process.env.LIVE_GRID_SOLO_FOCUS = String(i);
}

module.exports = {
  soloFocusSeat,
  soloSeatActive,
  mainGridEncodeEnabled,
  soloSeatEnvKey,
  readSoloSeatInt,
  applySoloSeatEncodeOverrides,
};
