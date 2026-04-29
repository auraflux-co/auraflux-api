'use strict';
/**
 * lib/health_cache.js — cached health check snapshot
 *
 * Runs expensive checks (FFmpeg spawn, disk space, VectCut HTTP) once at
 * startup and every 60s. The GET /health route returns the cached snapshot
 * instantly so it stays < 5ms under load.
 *
 * Usage:
 *   const { _healthCache, startHealthRefresh } = require('./health_cache');
 *   startHealthRefresh({ vectCutClient, TMP_DIR, OUTPUT_DIR });
 *   // then pass _healthCache to createAdminRouter
 */

const fs   = require('fs');
const path = require('path');
const { checkFFmpeg } = require('./ffmpeg_utils');

const _healthCache = {
  ffmpeg:        { status: 'pending', version: null },
  apiKeys:       {},
  directories:   {},
  vectcut:       { status: 'pending' },
  freeSpaceGB:   null,
  lastRefreshed: null,
};

/**
 * Refresh the health cache snapshot.
 *
 * @param {object} deps
 * @param {object} deps.vectCutClient  — instance with .healthCheck() method
 * @param {string} deps.TMP_DIR
 * @param {string} deps.OUTPUT_DIR
 */
async function _refreshHealthCache({ vectCutClient, TMP_DIR, OUTPUT_DIR }) {
  // FFmpeg
  try {
    const ver = await new Promise((resolve, reject) =>
      checkFFmpeg((err, v) => (err ? reject(err) : resolve(v)))
    );
    _healthCache.ffmpeg = { status: 'ok', version: ver };
  } catch (e) {
    _healthCache.ffmpeg = { status: 'error', error: e.message };
  }

  // API keys — presence check only, no network
  ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HEYGEN_API_KEY'].forEach((k) => {
    _healthCache.apiKeys[k] = { status: process.env[k] ? 'ok' : 'missing' };
  });

  // Directories — stat only
  for (const [name, dir] of Object.entries({ tmp: TMP_DIR, output: OUTPUT_DIR })) {
    try {
      fs.statSync(dir);
      _healthCache.directories[name] = { path: dir, exists: true, writable: true };
    } catch (e) {
      _healthCache.directories[name] = { path: dir, exists: false, error: e.message };
    }
  }

  // Disk space
  try {
    const freeKB = await new Promise((resolve, reject) => {
      const { exec } = require('child_process');
      exec(`df -k "${OUTPUT_DIR}" | awk 'NR==2 {print $4}'`, (err, stdout) =>
        err ? reject(err) : resolve(parseInt(stdout.trim()))
      );
    });
    const freeGB = parseFloat((freeKB / 1024 / 1024).toFixed(1));
    _healthCache.freeSpaceGB = freeGB;
    if (_healthCache.directories.output) {
      _healthCache.directories.output.freeSpaceGB = freeGB;
    }
  } catch (_e) { /* non-fatal */ }

  // VectCut — optional external call
  if (vectCutClient) {
    try {
      const vectCutHealth = await vectCutClient.healthCheck();
      _healthCache.vectcut = vectCutHealth.healthy
        ? { status: 'ok' }
        : { status: 'offline', error: vectCutHealth.error };
    } catch (e) {
      _healthCache.vectcut = { status: 'offline', error: e.message };
    }
  }

  _healthCache.lastRefreshed = new Date().toISOString();
}

/**
 * Prime the cache immediately, then refresh every 60 seconds.
 *
 * @param {object} deps  — same shape as _refreshHealthCache deps
 */
function startHealthRefresh(deps) {
  _refreshHealthCache(deps).catch(() => {});
  setInterval(() => _refreshHealthCache(deps).catch(() => {}), 60_000);
}

module.exports = { _healthCache, startHealthRefresh };
