'use strict';

/**
 * LIVE_GRID_WAS_LIVE — survives Render deploy when resume JSON is lost.
 * Set on successful GO LIVE; cleared only on intentional END STREAM (endBroadcast).
 * On Render, also writes /app/tmp/live_grid_was_live (persistent disk).
 */

const fs = require('fs');
const path = require('path');
const { upsertEnvFile } = require('../env_persist');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_ENV = path.join(REPO_ROOT, '.env');
const KEY = 'LIVE_GRID_WAS_LIVE';

function wasLivePath() {
  const dir = process.env.LIVE_GRID_RESUME_DIR
    || (process.env.RENDER ? '/app/tmp' : path.join(REPO_ROOT, 'data'));
  return path.join(dir, 'live_grid_was_live');
}

function wasLiveFlagged() {
  if (String(process.env[KEY] || '').toLowerCase() === '1'
    || String(process.env[KEY] || '').toLowerCase() === 'on'
    || String(process.env[KEY] || '').toLowerCase() === 'true') {
    return true;
  }
  try {
    return fs.readFileSync(wasLivePath(), 'utf8').trim() === '1';
  } catch (_) {
    return false;
  }
}

function markWasLive(opts = {}) {
  const envPath = opts.envPath || DEFAULT_ENV;
  process.env[KEY] = '1';
  try {
    fs.mkdirSync(path.dirname(wasLivePath()), { recursive: true });
    fs.writeFileSync(wasLivePath(), '1\n');
  } catch (_) {}
  try {
    upsertEnvFile(envPath, { [KEY]: '1' });
  } catch (_) {}
  return { ok: true };
}

function clearWasLive(opts = {}) {
  const envPath = opts.envPath || DEFAULT_ENV;
  delete process.env[KEY];
  try { fs.unlinkSync(wasLivePath()); } catch (_) {}
  try {
    upsertEnvFile(envPath, { [KEY]: '' });
  } catch (_) {}
  return { ok: true };
}

module.exports = {
  KEY,
  wasLivePath,
  wasLiveFlagged,
  markWasLive,
  clearWasLive,
};
