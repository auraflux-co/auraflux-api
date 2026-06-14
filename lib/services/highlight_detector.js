'use strict';
/**
 * lib/services/highlight_detector.js — CPD-441
 *
 * Detects high-energy audio windows in a video file using FFmpeg's
 * silencedetect filter (inverted: gaps between silence = loud sections).
 *
 * Returns an array of { start, end, score } timestamp windows, sorted
 * by score descending. The caller writes these to jobSpec.state.highlights
 * for assembly to use when trimming a long source into a highlights reel.
 *
 * Pure FFmpeg — no new APIs needed.
 */

const { execFile } = require('child_process');
const { ffmpegPath } = require('../ffmpeg_utils');

const DEFAULTS = {
  thresholdDb:  -25,  // audio below this = silence
  minDuration:   0.5, // minimum loud segment length (seconds)
  minGap:        0.8, // merge adjacent loud windows closer than this
  maxSegments:  10,   // cap returned highlights
  minSourceSecs: 120, // only run on sources longer than this
};

// ─── FFmpeg analysis ─────────────────────────────────────────────────────────

function _runSilenceDetect(videoPath, thresholdDb, minDuration) {
  return new Promise((resolve) => {
    const args = [
      '-i', videoPath,
      '-af', `silencedetect=n=${thresholdDb}dB:d=${minDuration}`,
      '-vn', '-sn', '-dn', '-f', 'null', '/dev/null',
    ];
    execFile(ffmpegPath(), args, { timeout: 120_000 }, (_err, _stdout, stderr) => {
      resolve(stderr || '');
    });
  });
}

function _parseDuration(stderr) {
  const m = stderr.match(/Duration:\s*([\d:.]+)/);
  if (!m) return 0;
  const [h, min, s] = m[1].split(':').map(parseFloat);
  return h * 3600 + min * 60 + s;
}

function _parseSilenceWindows(stderr) {
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends   = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const windows = [];
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    windows.push({ start: starts[i], end: ends[i] });
  }
  // Handle trailing silence that never received an end marker
  if (starts.length > ends.length) {
    windows.push({ start: starts[starts.length - 1], end: Infinity });
  }
  return windows;
}

// ─── Invert silence → loud windows ──────────────────────────────────────────

function _invertSilence(silenceWindows, totalDuration, minDuration) {
  const loud = [];
  let cursor = 0;

  for (const s of silenceWindows) {
    const loudEnd = s.start;
    if (loudEnd - cursor >= minDuration) {
      loud.push({ start: cursor, end: loudEnd });
    }
    cursor = s.end === Infinity ? totalDuration : s.end;
  }

  // Loud tail after final silence
  if (totalDuration - cursor >= minDuration) {
    loud.push({ start: cursor, end: totalDuration });
  }

  return loud;
}

function _mergeClose(windows, minGap) {
  const merged = [];
  for (const w of windows) {
    if (merged.length > 0 && w.start - merged[merged.length - 1].end <= minGap) {
      merged[merged.length - 1].end = w.end;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

function _scoreAndRank(windows, maxSegments) {
  const totalLoud = windows.reduce((s, w) => s + (w.end - w.start), 0) || 1;
  return windows
    .map(w => ({
      start: parseFloat(w.start.toFixed(3)),
      end:   parseFloat(w.end.toFixed(3)),
      score: parseFloat(((w.end - w.start) / totalLoud).toFixed(4)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSegments);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Detect high-energy audio moments in a video file.
 *
 * @param {string} videoPath
 * @param {Object} [opts]
 * @param {number} [opts.thresholdDb]   - dB threshold for silence (default -25)
 * @param {number} [opts.minDuration]   - min loud segment seconds (default 0.5)
 * @param {number} [opts.minGap]        - merge gap seconds (default 0.8)
 * @param {number} [opts.maxSegments]   - max windows returned (default 10)
 * @param {number} [opts.minSourceSecs] - skip files shorter than this (default 120)
 * @returns {Promise<Array<{start:number, end:number, score:number}>>}
 */
async function detectHighlights(videoPath, opts = {}) {
  const threshold   = opts.thresholdDb  ?? DEFAULTS.thresholdDb;
  const minDuration = opts.minDuration  ?? DEFAULTS.minDuration;
  const minGap      = opts.minGap       ?? DEFAULTS.minGap;
  const maxSegments = opts.maxSegments  ?? DEFAULTS.maxSegments;
  const minSource   = opts.minSourceSecs ?? DEFAULTS.minSourceSecs;

  const stderr       = await _runSilenceDetect(videoPath, threshold, minDuration);
  const totalDuration = _parseDuration(stderr);

  if (totalDuration < minSource) {
    // Source is short — the whole clip is the highlight
    return [{ start: 0, end: totalDuration, score: 1.0 }];
  }

  const silenceWindows = _parseSilenceWindows(stderr);

  if (silenceWindows.length === 0) {
    // No silence detected — entire source is energetic
    return [{ start: 0, end: totalDuration, score: 1.0 }];
  }

  const loudWindows  = _invertSilence(silenceWindows, totalDuration, minDuration);
  const merged       = _mergeClose(loudWindows, minGap);
  return _scoreAndRank(merged, maxSegments);
}

/**
 * Convenience: detect highlights and check if source qualifies for extraction.
 * @param {string} videoPath
 * @param {string} jobId
 * @param {Object} [opts]
 * @returns {Promise<{qualifies:boolean, highlights:Array}>}
 */
async function analyseSourceForHighlights(videoPath, jobId, opts = {}) {
  try {
    const highlights = await detectHighlights(videoPath, opts);
    const qualifies = highlights.length > 1 ||
      (highlights.length === 1 && highlights[0].end - highlights[0].start < (opts.minSourceSecs ?? DEFAULTS.minSourceSecs) * 0.8);
    console.log(
      `[highlight_detector:${jobId}] ${highlights.length} segment(s) found — ` +
      `qualifies for extraction: ${qualifies}`,
    );
    return { qualifies, highlights };
  } catch (err) {
    console.warn(`[highlight_detector:${jobId}] Analysis failed: ${err.message}`);
    return { qualifies: false, highlights: [] };
  }
}

module.exports = { detectHighlights, analyseSourceForHighlights };
