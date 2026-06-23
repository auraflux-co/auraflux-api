'use strict';

const fs = require('fs');
const path = require('path');
const { upsertEnvFile } = require('../env_persist');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_ENV = path.join(REPO_ROOT, '.env');
const GO_LIVE_CONFIG = path.join(REPO_ROOT, 'config', 'live_grid_go_live.json');

function loadDeadBroadcastIds() {
  try {
    if (!fs.existsSync(GO_LIVE_CONFIG)) return new Set();
    const cfg = JSON.parse(fs.readFileSync(GO_LIVE_CONFIG, 'utf8'));
    return new Set(cfg.deadBroadcastIds || []);
  } catch (_) {
    return new Set();
  }
}

/** Accept raw video id or a YouTube watch/live URL. */
function normalizeListingId(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const fromUrl = s.match(/(?:live\/|watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return s.length >= 8 ? s : null;
}

function readYoutubeListing() {
  const broadcastId = process.env.LIVE_GRID_BROADCAST_ID || null;
  const watchUrl = process.env.LIVE_GRID_WATCH_URL
    || (broadcastId ? `https://youtube.com/live/${broadcastId}` : null);
  const dead = loadDeadBroadcastIds();
  return {
    broadcastId,
    watchUrl,
    streamId: process.env.LIVE_GRID_STREAM_ID || null,
    rtmpUrl: process.env.LIVE_GRID_RTMP_URL || process.env.YOUTUBE_LIVE_RTMP_URL || null,
    stale: broadcastId ? dead.has(broadcastId) : false,
  };
}

/**
 * Write Studio listing to .env + process.env (dashboard is source of truth).
 */
function persistYoutubeListing(opts = {}) {
  const envPath = opts.envPath || DEFAULT_ENV;
  const bid = normalizeListingId(opts.broadcastId);
  if (!bid) {
    const updates = {
      LIVE_GRID_BROADCAST_ID: '',
      LIVE_GRID_WATCH_URL: '',
    };
    upsertEnvFile(envPath, updates);
    return { ok: true, cleared: true, broadcastId: null, watchUrl: null };
  }

  const dead = loadDeadBroadcastIds();
  if (dead.has(bid)) {
    throw new Error(`YouTube listing ${bid} is closed — create a new listing in Studio first`);
  }

  const watchUrl = opts.watchUrl || `https://youtube.com/live/${bid}`;
  const updates = {
    LIVE_GRID_BROADCAST_ID: bid,
    LIVE_GRID_WATCH_URL: watchUrl,
  };
  if (opts.streamId) updates.LIVE_GRID_STREAM_ID = opts.streamId;
  if (opts.rtmpUrl) updates.LIVE_GRID_RTMP_URL = opts.rtmpUrl;

  upsertEnvFile(envPath, updates);
  return { ok: true, broadcastId: bid, watchUrl, ...updates };
}

module.exports = {
  normalizeListingId,
  readYoutubeListing,
  persistYoutubeListing,
  loadDeadBroadcastIds,
};
