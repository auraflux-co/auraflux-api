'use strict';

/**
 * Render broadcast encode profile — single source for auraflux-broadcast-staging.
 * Loads config/live_grid_profile_render.json and applies YouTube CDN aspect before GO LIVE.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROFILE_PATH = path.join(__dirname, '..', '..', 'config', 'live_grid_profile_render.json');

/** Keys always owned by the Render profile (never inherit c0 Mac .env). */
const RENDER_LOCKED_KEYS = new Set([
  'LIVE_GRID_ENCODER',
  'LIVE_GRID_X264_PRESET',
  'LIVE_GRID_CELL_FIT',
  'LIVE_GRID_FPS',
  'LIVE_GRID_OUTPUT_W',
  'LIVE_GRID_OUTPUT_H',
  'LIVE_GRID_BITRATE_K',
  'LIVE_GRID_X264_MAXRATE_K',
  'LIVE_GRID_X264_BUFSIZE_K',
  'LIVE_GRID_AUDIO_BITRATE_K',
  'LIVE_GRID_AUTOTUNE',
  'LIVE_GRID_AUTOTUNE_LOAD',
  'LIVE_GRID_RELAY_TRANSCODE',
  'LIVE_GRID_UDP_RELAY',
  'LIVE_GRID_TWITCH_QUALITY',
  'LIVE_GRID_OUTPUT_MIDDLEWARE',
  'LIVE_GRID_STAGED_SWAP',
  'LIVE_GRID_RESTREAMER_HOLD',
  'LIVE_GRID_SWAP_DEBOUNCE_MS',
  'LIVE_GRID_SWAP_STABLE_MS',
  'LIVE_GRID_LOCAL_HLS',
  'LIVE_GRID_MUSIC_GUARD',
  'LIVE_GRID_AUDIO_DIRECT',
  'LIVE_GRID_AUDIO_COPY',
  'STREAM_DELIVERY_AUTO_HEAL',
  'LIVE_SIDECAR_HEARTBEAT_MS',
  'STREAM_DELIVERY_HEAL_COOLDOWN_SEC',
  'STREAM_DELIVERY_COMPOSITOR_HEAL_COOLDOWN_SEC',
  'LIVE_GRID_POST_SWAP_DELIVERY_CHECK_MS',
  'LIVE_GRID_DELIVERY_HLS_STALE_MS',
  'LIVE_GRID_YOUTUBE_DUAL_STREAM',
  'LIVE_GRID_DUAL_BROADCAST',
  'RENDER',
]);

function loadRenderProfileFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
    return raw.env || {};
  } catch (e) {
    return null;
  }
}

function renderProfileEnabled() {
  return String(process.env.RENDER || '').toLowerCase() === 'true'
    || process.env.NODE_ENV === 'staging';
}

function youtubeDualStreamEnabled() {
  return String(process.env.LIVE_GRID_YOUTUBE_DUAL_STREAM || 'off').toLowerCase() === 'on';
}

/**
 * Apply locked encode vars from config/live_grid_profile_render.json.
 * @param {(msg: string) => void} [log]
 */
function applyRenderProfile(log) {
  if (!renderProfileEnabled()) return { applied: false, reason: 'not_render' };
  const profile = loadRenderProfileFile();
  if (!profile) return { applied: false, reason: 'profile_missing' };

  process.env.RENDER = 'true';
  const keys = [];
  for (const [key, value] of Object.entries(profile)) {
    if (!RENDER_LOCKED_KEYS.has(key)) continue;
    if (value == null || value === '') continue;
    process.env[key] = String(value);
    keys.push(key);
  }
  log?.(`Render encode profile applied (${keys.length} vars from ${path.basename(PROFILE_PATH)})`);
  return { applied: true, keys };
}

function probeYoutubeCdnDims(watchUrl) {
  if (!watchUrl) return { error: 'no watchUrl' };
  try {
    const raw = execFileSync('yt-dlp', ['-j', '--no-download', watchUrl], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const d = JSON.parse(raw);
    const fmts = (d.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none');
    const best = fmts.sort((a, b) => (b.height || 0) - (a.height || 0))[0] || {};
    const width = d.width || best.width;
    const height = d.height || best.height;
    return {
      width,
      height,
      square: !!(width && height && width === height),
      source: 'youtube_cdn',
    };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Match compositor canvas to YouTube CDN slot (square vs landscape).
 * @param {string} watchUrl
 * @param {(msg: string) => void} [log]
 */
function applyYoutubeOutputDims(watchUrl, log) {
  if (!renderProfileEnabled() || !watchUrl) return { skipped: true };

  if (!youtubeDualStreamEnabled()) {
    process.env.LIVE_GRID_OUTPUT_W = '1920';
    process.env.LIVE_GRID_OUTPUT_H = '1080';
    log?.('YouTube dual stream off — encode 1920×1080 landscape (disable Dual stream in Studio before GO LIVE)');
    return { applied: true, outW: 1920, outH: 1080, mode: 'landscape_forced' };
  }

  const probe = probeYoutubeCdnDims(watchUrl);
  if (probe.error) {
    log?.(`YouTube aspect probe skipped: ${probe.error} — using profile canvas`);
    return { skipped: true, reason: probe.error };
  }

  const { width: yw, height: yh, square } = probe;
  let outW;
  let outH;

  if (square && yw) {
    const side = Math.min(1080, yw);
    outW = side;
    outH = side;
  } else if (yw && yh && yw > yh) {
    outW = Math.min(1920, yw);
    outH = Math.round(outW * (yh / yw));
    if (outH % 2) outH += 1;
  } else if (yw && yh) {
    outH = Math.min(1920, yh);
    outW = Math.round(outH * (yw / yh));
    if (outW % 2) outW += 1;
  } else {
    return { skipped: true, probe };
  }

  process.env.LIVE_GRID_OUTPUT_W = String(outW);
  process.env.LIVE_GRID_OUTPUT_H = String(outH);
  log?.(
    `YouTube CDN ${yw}×${yh}${square ? ' (square)' : ''} → encode ${outW}×${outH} native`
  );
  return { applied: true, outW, outH, probe };
}

module.exports = {
  PROFILE_PATH,
  RENDER_LOCKED_KEYS,
  loadRenderProfileFile,
  renderProfileEnabled,
  youtubeDualStreamEnabled,
  applyRenderProfile,
  probeYoutubeCdnDims,
  applyYoutubeOutputDims,
};
