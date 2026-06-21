'use strict';
/**
 * Kick HLS ingest helpers (CPD-1065)
 *
 * Kick CDN HLS often carries H.264 with non-monotonic DTS / POC issues that
 * break ffmpeg copy → mpegts → relay chains. Transcode to clean yuv420p H.264
 * at the feeder so any Kick slug on any quadrant is production-safe.
 */

const { isKickPlaybackUrl } = require('../clients/kick_live_resolver');

function kickHlsTranscodeEnabled() {
  return String(process.env.LIVE_GRID_KICK_HLS_TRANSCODE ?? 'on').toLowerCase() !== 'off';
}

/** Stable playlist identity — signed ?token= changes every refresh. */
function kickPlaylistKey(url) {
  try {
    const u = new URL(String(url || ''));
    if (!isKickPlaybackUrl(u.href)) return null;
    return `${u.hostname}${u.pathname}`;
  } catch {
    return null;
  }
}

function kickPlaylistUrlsEquivalent(a, b) {
  const ka = kickPlaylistKey(a);
  const kb = kickPlaylistKey(b);
  return !!(ka && kb && ka === kb);
}

function isKickFeed({ kickSlug, url } = {}) {
  if (kickSlug) return true;
  return isKickPlaybackUrl(url);
}

/** ffmpeg input + encode args for Kick HLS (no output muxer). */
function kickHlsFfmpegInputEncodeArgs(url) {
  const fps = parseInt(process.env.LIVE_GRID_KICK_HLS_FPS || process.env.LIVE_GRID_FPS || '30', 10);
  const scaleW = parseInt(process.env.LIVE_GRID_KICK_HLS_W || '1280', 10);
  const scaleH = parseInt(process.env.LIVE_GRID_KICK_HLS_H || '720', 10);
  const bitrateK = parseInt(process.env.LIVE_GRID_KICK_HLS_BITRATE_K || '2500', 10);
  const preset = process.env.LIVE_GRID_X264_PRESET || 'ultrafast';
  const gop = fps * 2;
  const vf = [
    `scale=${scaleW}:${scaleH}:flags=fast_bilinear:force_original_aspect_ratio=decrease`,
    `pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'format=yuv420p',
    'setsar=1',
  ].join(',');

  return [
    '-hide_banner', '-loglevel', 'warning',
    '-probesize', '10M', '-analyzeduration', '10M',
    '-thread_queue_size', '4096',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-reconnect_on_http_error', '4xx,5xx',
    '-i', url,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', vf,
    '-r', String(fps), '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', preset, '-tune', 'zerolatency',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-b:v', `${bitrateK}k`, '-maxrate', `${bitrateK}k`, '-bufsize', `${bitrateK * 2}k`,
    '-g', String(gop), '-keyint_min', String(gop),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-max_muxing_queue_size', '8192',
  ];
}

/** Generic signed HLS copy path (non-Kick). */
function genericHlsFfmpegInputArgs(url) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', url,
    '-c', 'copy',
  ];
}

function hlsFfmpegArgs(url, opts = {}) {
  const kick = isKickFeed(opts);
  if (kick && kickHlsTranscodeEnabled()) {
    return kickHlsFfmpegInputEncodeArgs(url);
  }
  return genericHlsFfmpegInputArgs(url);
}

function kickHlsStallTimeoutMs() {
  return parseInt(process.env.LIVE_GRID_KICK_HLS_STALL_MS || '45000', 10);
}

module.exports = {
  kickHlsTranscodeEnabled,
  kickPlaylistKey,
  kickPlaylistUrlsEquivalent,
  isKickFeed,
  kickHlsStallTimeoutMs,
  kickHlsFfmpegInputEncodeArgs,
  hlsFfmpegArgs,
};
