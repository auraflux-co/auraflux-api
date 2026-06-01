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

/**
 * Quality encode: chrome overlays, final delivery pass.
 * CPD-482: 'medium' preset (was 'fast') — produces ~15% smaller files at same CRF
 * with better artifact suppression on streaming content. Safe now that chrome
 * overlay uses a dynamic timeout (CPD-481: min 10 min, 4× video duration).
 */
const ENC_V_QUALITY = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p'];

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

/**
 * H.264 High Profile @ Level 4.1 — CPD-484.
 * Required for mobile/social compatibility. High profile enables B-frames and
 * CABAC for better compression; Level 4.1 is the ceiling for most phones and
 * smart TVs (supports 1080p30 and 720p60).
 * Apply to FINAL delivery encodes only.
 */
const PROFILE_HIGH_41 = ['-profile:v', 'high', '-level:v', '4.1'];

/**
 * Avoid negative timestamps on mux output — CPD-484.
 * Concat / HLS demux can produce streams with negative PTS values (e.g. from
 * DTS-leading packets). The MP4 muxer may reject or reorder these, causing
 * audio/video drift or mux failures. make_zero shifts the timeline so the
 * earliest PTS is 0.
 */
const AVOID_NEG_TS = ['-avoid_negative_ts', 'make_zero'];

/**
 * EBU R128 loudness normalisation — CPD-484.
 * Target -16 LUFS integrated, -1.5 dBTP true peak, 11 LU range.
 * YouTube enforces -14 LUFS; -16 gives a small headroom buffer.
 * Use as an -af filter string on the audio post-processing pass.
 */
const LOUDNORM_R128 = 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=none';

/**
 * Web keyframe alignment — CPD-482.
 * Sets a forced keyframe every 60 frames (2s at 30fps) and a minimum interval
 * of 30 frames (1s). Without this, H.264 GOP size defaults to ~250 frames
 * (~8s at 30fps), which causes 8-second seeking jumps in YouTube/TikTok
 * players and breaks HLS segment alignment.
 *
 * Apply to FINAL delivery encodes only (chrome overlay, not intermediate concat).
 */
const KEYFRAME_WEB = ['-g', '60', '-keyint_min', '30'];

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
  KEYFRAME_WEB,
  PROFILE_HIGH_41,
  AVOID_NEG_TS,
  LOUDNORM_R128,
  AFORMAT_48K,
  buildFilterComplex,
  buildFilterChain,
};
