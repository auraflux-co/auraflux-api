'use strict';

const fs = require('fs');
const path = require('path');
const { GRID_DIR } = require('./feeders');

const PREVIEW_DIR = path.join(GRID_DIR, 'preview');
const HLS_INDEX = path.join(PREVIEW_DIR, 'index.m3u8');

function localPreviewEnabled() {
  return String(process.env.LIVE_GRID_LOCAL_HLS || 'on').toLowerCase() !== 'off';
}

function localOnlyMode() {
  return String(process.env.LIVE_GRID_LOCAL_ONLY || '').toLowerCase() === 'on';
}

function apiBaseUrl() {
  const port = process.env.PORT || 3000;
  return (process.env.LIVE_GRID_LOCAL_API_BASE || `http://127.0.0.1:${port}`).replace(/\/$/, '');
}

function resolveLocalPreviewConfig() {
  const hlsEnabled = localPreviewEnabled();
  const localOnly = localOnlyMode();
  const base = apiBaseUrl();
  return {
    localOnly,
    hlsEnabled: localOnly || hlsEnabled,
    hlsPath: HLS_INDEX,
    hlsUrl: `${base}/broadcast/preview-hls/index.m3u8`,
    watchPageUrl: `${base}/broadcast/local-watch`,
    previewDir: PREVIEW_DIR,
    rtspBase: process.env.LIVE_GRID_RTSP_BASE || 'rtsp://localhost:8554',
  };
}

/** True when preview dir has a playlist (may be stale from a prior session). */
function hlsPreviewReady() {
  try {
    return fs.existsSync(HLS_INDEX) && fs.statSync(HLS_INDEX).size > 0;
  } catch (_) {
    return false;
  }
}

/** True when HLS segments are being written now (same encode as master). */
function hlsPreviewLive(maxAgeMs = 15000) {
  try {
    if (!fs.existsSync(HLS_INDEX)) return false;
    const playlist = fs.readFileSync(HLS_INDEX, 'utf8');
    const segments = playlist.split('\n').filter((l) => l && !l.startsWith('#'));
    const last = segments[segments.length - 1];
    if (!last) return false;
    const segPath = path.join(PREVIEW_DIR, last.trim());
    if (!fs.existsSync(segPath)) return false;
    return Date.now() - fs.statSync(segPath).mtimeMs < maxAgeMs;
  } catch (_) {
    return false;
  }
}

function twitchWatchUrl(login) {
  if (!login || login === 'empty') return null;
  return `https://www.twitch.tv/${String(login).replace(/^@/, '')}`;
}

function rtspQuadUrl(rtspBase, quad) {
  return `${String(rtspBase).replace(/\/$/, '')}/quad${quad}`;
}

module.exports = {
  PREVIEW_DIR,
  HLS_INDEX,
  localPreviewEnabled,
  localOnlyMode,
  resolveLocalPreviewConfig,
  hlsPreviewReady,
  hlsPreviewLive,
  twitchWatchUrl,
  rtspQuadUrl,
};
