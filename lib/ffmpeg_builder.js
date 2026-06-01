'use strict';

/**
 * ffmpeg_builder.js — CPD-480
 *
 * Shared FFmpeg encoding presets and filter graph helpers.
 * Centralising these prevents inconsistency across assembly_service.js,
 * assembly_postprocess.js, and portal workers.
 *
 * Usage:
 *   const { ENC_V_FAST, ENC_A_192, buildFilterComplex } = require('./ffmpeg_builder');
 *   const args = ['-i', input, '-filter_complex', fc, '-map', '[v]', ...ENC_V_FAST, ...ENC_A_192, '-y', output];
 */

// ---------------------------------------------------------------------------
// Video encoding presets — all include -pix_fmt yuv420p for universal
// device/browser compatibility (H.264 High Profile requires yuv420p for
// playback on iOS, Android, smart TVs, and all major web browsers).
// ---------------------------------------------------------------------------

/** General-purpose fast encode: previews, intermediate clips, short-form. */
const ENC_V_FAST = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p'];

/** Quality encode: chrome overlays, final portrait reframe passes. */
const ENC_V_QUALITY = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p'];

/** Low-bitrate fallback: demuxer concat path, clip extraction at lower res. */
const ENC_V_PREVIEW = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p'];

// ---------------------------------------------------------------------------
// Audio encoding presets
// 48000 Hz: YouTube, broadcast, and Apple all recommend 48kHz over 44.1kHz.
// Using 44.1kHz on YouTube triggers a re-sample that can introduce drift.
// ---------------------------------------------------------------------------

/** Final delivery audio: 48kHz stereo AAC 192k (YouTube upload recommendation). */
const ENC_A_192 = ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k'];

/** Streaming / intermediate audio: 48kHz stereo AAC 128k. */
const ENC_A_128 = ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k'];

/** Low-bitrate clip extraction audio: 48kHz AAC 96k. */
const ENC_A_96 = ['-c:a', 'aac', '-ar', '48000', '-b:a', '96k'];

/** Stream copy — no re-encode; use when video was already encoded to spec. */
const ENC_A_COPY = ['-c:a', 'copy'];

/** MP4 faststart: moves moov atom to the front for instant web playback. */
const FASTSTART = ['-movflags', '+faststart'];

// ---------------------------------------------------------------------------
// Audio normalization filter — must match ENC_A_* sample rates above.
// ---------------------------------------------------------------------------

/** aformat filter string for use in filter_complex audio chains. */
const AFORMAT_48K = 'aformat=sample_rates=48000:channel_layouts=stereo';

// ---------------------------------------------------------------------------
// Filter graph helpers
// ---------------------------------------------------------------------------

/**
 * Join filter_complex graph segments (separate chains) with semicolons.
 * Each segment must end with a named output label, e.g. [vout].
 *
 * @param  {...string} segments
 * @returns {string}
 */
function buildFilterComplex(...segments) {
  return segments.filter(Boolean).join('; ');
}

/**
 * Join sequential filters within one stream with commas.
 *
 * @param  {...string} filters
 * @returns {string}
 */
function buildFilterChain(...filters) {
  return filters.filter(Boolean).join(',');
}

module.exports = {
  ENC_V_FAST,
  ENC_V_QUALITY,
  ENC_V_PREVIEW,
  ENC_A_192,
  ENC_A_128,
  ENC_A_96,
  ENC_A_COPY,
  FASTSTART,
  AFORMAT_48K,
  buildFilterComplex,
  buildFilterChain,
};
