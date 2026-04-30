'use strict';
/**
 * lib/ai/video_transforms.js — Long-to-short and short-to-long AI video workflows (CPD-4)
 *
 * long-to-short: highlights extraction from a long-form video → short clip (Shorts/Reels ready)
 * short-to-long: stitch N short clips into a long-form production with transitions
 *
 * Both workflows use Gemini Flash for segment selection + ffmpeg for the transform.
 * Feature gates: video.wan_t2v (dwy+) for model-assisted transforms.
 *
 * These are scaffolded for sprint implementation — the Gemini selection step
 * requires transcription data from the job spec or an upstream assembly pass.
 */

const path = require('path');
const { isFeatureEnabled } = require('../services/feature_gate');
const { logError } = require('../error_logger');
const { execAsync } = require('../ffmpeg_utils');

// ─── Long-to-short ────────────────────────────────────────────────────────────

/**
 * Extract a highlight clip from a long-form video.
 *
 * @param {object} opts
 * @param {string} opts.inputPath        — Path to the source long-form video
 * @param {string} opts.outputPath       — Destination for the short clip
 * @param {object} opts.jobSpec          — Full job spec (customerId, planTier, etc.)
 * @param {number} [opts.targetDuration] — Target clip length in seconds (default: 60)
 * @param {'9:16'|'1:1'|'16:9'} [opts.aspect] — Output aspect ratio (default: 9:16 for Shorts)
 * @param {object[]} [opts.segments]     — Pre-selected segments [{ start, end, score }].
 *                                         If omitted, best-scoring middle third is used.
 * @returns {object} { outputPath, durationSec, aspect }
 */
async function longToShort(opts = {}) {
  const {
    inputPath,
    outputPath,
    jobSpec,
    targetDuration = 60,
    aspect = '9:16',
    segments = null,
  } = opts;

  if (!isFeatureEnabled('video.wan_t2v', jobSpec?.planTier)) {
    return { skipped: true, reason: 'video.wan_t2v not enabled for plan' };
  }

  if (!inputPath || !outputPath) {
    throw new Error('longToShort: inputPath and outputPath are required');
  }

  // ── Determine best segment ───────────────────────────────────────────────
  let startSec = 0;
  let clipDuration = targetDuration;

  if (segments && segments.length > 0) {
    // Use highest-scoring segment
    const best = segments.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    startSec    = best.start || 0;
    clipDuration = Math.min(targetDuration, (best.end || targetDuration) - startSec);
  } else {
    // Default: probe duration and pick middle third
    try {
      const probe = await execAsync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`
      );
      const totalDuration = parseFloat(probe.stdout.trim());
      if (!isNaN(totalDuration) && totalDuration > targetDuration) {
        const third = totalDuration / 3;
        startSec = third;
        clipDuration = Math.min(targetDuration, third);
      }
    } catch (_e) { /* use defaults */ }
  }

  // ── Build ffmpeg filter for aspect ratio reformat ────────────────────────
  const scaleFilter = _buildAspectFilter(aspect);

  const cmd = [
    'ffmpeg -y',
    `-ss ${startSec.toFixed(3)}`,
    `-i "${inputPath}"`,
    `-t ${clipDuration.toFixed(3)}`,
    `-vf "${scaleFilter}"`,
    '-c:v libx264 -preset fast -crf 22',
    '-c:a aac -b:a 128k',
    `-movflags +faststart`,
    `"${outputPath}"`,
  ].join(' ');

  await execAsync(cmd);

  return { outputPath, durationSec: clipDuration, aspect, startSec };
}

// ─── Short-to-long ────────────────────────────────────────────────────────────

/**
 * Stitch N short clips into a longer production.
 *
 * @param {object} opts
 * @param {string[]} opts.inputPaths     — Ordered list of clip paths to concatenate
 * @param {string}   opts.outputPath     — Destination for the assembled video
 * @param {object}   opts.jobSpec
 * @param {'fade'|'none'} [opts.transition] — Transition style (default: 'fade')
 * @param {number}   [opts.transitionDur]   — Transition duration in seconds (default: 0.5)
 * @returns {object} { outputPath, clipCount, totalDurationSec }
 */
async function shortToLong(opts = {}) {
  const {
    inputPaths = [],
    outputPath,
    jobSpec,
    transition = 'fade',
    transitionDur = 0.5,
  } = opts;

  if (!isFeatureEnabled('video.wan_t2v', jobSpec?.planTier)) {
    return { skipped: true, reason: 'video.wan_t2v not enabled for plan' };
  }

  if (inputPaths.length === 0) throw new Error('shortToLong: at least one inputPath required');
  if (!outputPath) throw new Error('shortToLong: outputPath required');

  if (inputPaths.length === 1) {
    // Nothing to stitch — copy through
    await execAsync(`ffmpeg -y -i "${inputPaths[0]}" -c copy "${outputPath}"`);
    return { outputPath, clipCount: 1, totalDurationSec: null };
  }

  if (transition === 'none') {
    // Simple concat via concat demuxer
    const listFile = outputPath + '.list.txt';
    const listContent = inputPaths.map((p) => `file '${path.resolve(p)}'`).join('\n');
    require('fs').writeFileSync(listFile, listContent);
    await execAsync(
      `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 22 -c:a aac "${outputPath}"`
    );
    require('fs').unlinkSync(listFile);
    return { outputPath, clipCount: inputPaths.length, totalDurationSec: null };
  }

  // Fade transition via xfade filter
  // Probe all clip durations to compute xfade offsets
  const durations = await _probeDurations(inputPaths);
  const filterResult = _buildXfadeFilter(inputPaths, durations, transitionDur);

  const inputs = inputPaths.map((p) => `-i "${p}"`).join(' ');
  const cmd = [
    `ffmpeg -y ${inputs}`,
    `-filter_complex "${filterResult.filter}"`,
    `-map "[vout]" -map "[aout]"`,
    '-c:v libx264 -preset fast -crf 22 -c:a aac',
    `-movflags +faststart`,
    `"${outputPath}"`,
  ].join(' ');

  await execAsync(cmd);
  const totalDurationSec = durations.reduce((s, d) => s + d, 0) - transitionDur * (inputPaths.length - 1);
  return { outputPath, clipCount: inputPaths.length, totalDurationSec };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _buildAspectFilter(aspect) {
  const maps = {
    '9:16': 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
    '1:1':  'scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080',
    '16:9': 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080',
  };
  return maps[aspect] || maps['9:16'];
}

async function _probeDurations(inputPaths) {
  const durations = [];
  for (const p of inputPaths) {
    try {
      const { execAsync: exec } = require('../ffmpeg_utils');
      const res = await execAsync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`
      );
      durations.push(parseFloat(res.stdout.trim()) || 5);
    } catch (_e) {
      durations.push(5); // assume 5s on probe failure
    }
  }
  return durations;
}

function _buildXfadeFilter(inputPaths, durations, transitionDur) {
  // Build chain: [0][1]xfade=fade:offset=d0-t[v01]; [v01][2]xfade=fade:offset=d0+d1-2t[v012]; ...
  let videoChain = '[0:v]';
  let audioChain = '[0:a]';
  let offset = 0;
  const transitions = [];

  for (let i = 1; i < inputPaths.length; i++) {
    offset += durations[i - 1] - transitionDur;
    const vLabel = `v${i}`;
    const aLabel = `a${i}`;
    transitions.push(
      `${videoChain}[${i}:v]xfade=transition=fade:duration=${transitionDur}:offset=${offset.toFixed(3)}[${vLabel}]`
    );
    transitions.push(
      `${audioChain}[${i}:a]acrossfade=d=${transitionDur}[${aLabel}]`
    );
    videoChain = `[${vLabel}]`;
    audioChain = `[${aLabel}]`;
  }

  // Rename final outputs
  const finalFilter = transitions.join('; ') +
    `; ${videoChain}copy[vout]; ${audioChain}acopy[aout]`;

  return { filter: finalFilter };
}

module.exports = { longToShort, shortToLong };
