'use strict';

/**
 * Render broadcast encode profile — single source for auraflux-broadcast-staging.
 * Loads config/live_grid_profile_render.json and applies YouTube CDN aspect before GO LIVE.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const DEFAULT_PROFILE_PATH = path.join(CONFIG_DIR, 'live_grid_profile_render.json');

function resolveProfilePath() {
  const name = process.env.LIVE_GRID_RENDER_PROFILE;
  if (!name) return DEFAULT_PROFILE_PATH;
  if (path.isAbsolute(name)) return name;
  if (name.endsWith('.json')) return path.join(CONFIG_DIR, name);
  return path.join(CONFIG_DIR, `live_grid_profile_${name}.json`);
}

const PROFILE_PATH = DEFAULT_PROFILE_PATH;

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
  'LIVE_GRID_STUDIO_DUAL_FIRST',
  'LIVE_GRID_AUTO_RESUME',
  'LIVE_GRID_OPERATOR_MODE',
  'LIVE_GRID_PLATFORM_BENCH',
  'LIVE_GRID_BENCH',
  'LIVE_GRID_DUAL_BROADCAST',
  'LIVE_GRID_SOLO_STREAMS',
  'LIVE_GRID_SOLO_STREAMER_LOCK',
  'LIVE_GRID_SOLO_AUTO_START',
  'LIVE_GRID_SOLO_WAIT_YOUTUBE_LIVE',
  'LIVE_GRID_SOLO_START_STAGGER_MS',
  'LIVE_GRID_SOLO_UDP_INPUT',
  'LIVE_GRID_SOLO_BITRATE_K',
  'LIVE_GRID_SOLO_OUTPUT_W',
  'LIVE_GRID_SOLO_OUTPUT_H',
  'LIVE_GRID_SOLO_4_BITRATE_K',
  'LIVE_GRID_SOLO_4_X264_MAXRATE_K',
  'LIVE_GRID_SOLO_4_X264_BUFSIZE_K',
  'LIVE_GRID_SOLO_4_OUTPUT_W',
  'LIVE_GRID_SOLO_4_OUTPUT_H',
  'LIVE_GRID_SOLO_1_BITRATE_K',
  'LIVE_GRID_SOLO_1_X264_MAXRATE_K',
  'LIVE_GRID_SOLO_1_X264_BUFSIZE_K',
  'LIVE_GRID_SOLO_1_OUTPUT_W',
  'LIVE_GRID_SOLO_1_OUTPUT_H',
  'LIVE_GRID_SOLO_1_AUDIO_BITRATE_K',
  'LIVE_GRID_SOLO_2_BITRATE_K',
  'LIVE_GRID_SOLO_2_X264_MAXRATE_K',
  'LIVE_GRID_SOLO_2_X264_BUFSIZE_K',
  'LIVE_GRID_SOLO_2_OUTPUT_W',
  'LIVE_GRID_SOLO_2_OUTPUT_H',
  'LIVE_GRID_SOLO_2_AUDIO_BITRATE_K',
  'LIVE_GRID_SOLO_3_BITRATE_K',
  'LIVE_GRID_SOLO_3_X264_MAXRATE_K',
  'LIVE_GRID_SOLO_3_X264_BUFSIZE_K',
  'LIVE_GRID_SOLO_3_OUTPUT_W',
  'LIVE_GRID_SOLO_3_OUTPUT_H',
  'LIVE_GRID_SOLO_3_AUDIO_BITRATE_K',
  'LIVE_GRID_SOLO_4_AUDIO_BITRATE_K',
  'LIVE_GRID_SOLO_FOCUS',
  'LIVE_GRID_MAIN_ENCODE',
  'LIVE_GRID_SOLO_CHAT_ANNOUNCE',
  'LIVE_GRID_YOUTUBE_GO_LIVE_WAIT',
  'LIVE_GRID_YOUTUBE_GO_LIVE_WAIT_MS',
  'LIVE_GRID_YOUTUBE_GO_LIVE_POLL_MS',
  'LIVE_GRID_RESUME_DIR',
  'RENDER',
  'LIVE_GRID_KICK_INGEST',
  'LIVE_GRID_TWITCH_PROBE',
]);

function loadRenderProfileFile(profilePath = resolveProfilePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
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
  return String(process.env.LIVE_GRID_YOUTUBE_DUAL_STREAM ?? 'on').toLowerCase() === 'on';
}

/**
 * Apply locked encode vars from config/live_grid_profile_render.json.
 * @param {(msg: string) => void} [log]
 */
function applyRenderProfile(log) {
  if (!renderProfileEnabled()) return { applied: false, reason: 'not_render' };
  const profilePath = resolveProfilePath();
  const profile = loadRenderProfileFile(profilePath);
  if (!profile) return { applied: false, reason: 'profile_missing', profilePath };

  process.env.RENDER = 'true';
  const keys = [];
  for (const [key, value] of Object.entries(profile)) {
    if (!RENDER_LOCKED_KEYS.has(key)) continue;
    if (value == null || value === '') continue;
    process.env[key] = String(value);
    keys.push(key);
  }
  log?.(`Render encode profile applied (${keys.length} vars from ${path.basename(profilePath)})`);
  return { applied: true, keys, profilePath };
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

  if (youtubeDualStreamEnabled()) {
    process.env.LIVE_GRID_OUTPUT_W = '1920';
    process.env.LIVE_GRID_OUTPUT_H = '1080';
    log?.('YouTube native dual (CPD-1029) — encode 1920×1080 landscape; enable Dual stream → Auto in Studio before RTMP');
    return { applied: true, outW: 1920, outH: 1080, mode: 'landscape_dual_ingest' };
  }

  process.env.LIVE_GRID_OUTPUT_W = '1920';
  process.env.LIVE_GRID_OUTPUT_H = '1080';
  log?.('YouTube dual stream off — encode 1920×1080 landscape');
  return { applied: true, outW: 1920, outH: 1080, mode: 'landscape_forced' };
}

module.exports = {
  CONFIG_DIR,
  PROFILE_PATH,
  DEFAULT_PROFILE_PATH,
  resolveProfilePath,
  RENDER_LOCKED_KEYS,
  loadRenderProfileFile,
  renderProfileEnabled,
  youtubeDualStreamEnabled,
  applyRenderProfile,
  probeYoutubeCdnDims,
  applyYoutubeOutputDims,
};
