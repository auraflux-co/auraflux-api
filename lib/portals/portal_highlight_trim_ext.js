'use strict';
/**
 * lib/portals/portal_highlight_trim_ext.js — Highlight Trim Extension (CPD-217)
 *
 * For ENHANCE single-clip jobs, asks Gemini to estimate the highlight window from
 * the clip title and duration, then trims dead time from start/end using ffmpeg.
 *
 * Only activates when:
 *   - contentFlow === 'enhance' (single-clip or few-clip ENHANCE jobs)
 *   - clips_count === 1 (single source clip — ENHANCE not COMPACT)
 *   - source clip duration is long enough that trimming adds value (> 20s)
 *   - Gemini returns a trim window that saves at least 20% of the clip
 *
 * Non-fatal: all errors fall back to skip (original assembled file unchanged).
 * Runs after assembleForJob(), before TTS mixing.
 */

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { ffmpegPath } = require('../ffmpeg_utils');
const { isFeatureEnabled } = require('../services/feature_gate');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * Ask Gemini to estimate the highlight window from clip metadata (title, duration, game).
 * Returns null if Gemini can't determine a meaningful trim, or if the clip doesn't
 * need trimming.
 *
 * @param {object} params
 * @param {string} params.clipTitle
 * @param {number} params.durationSec
 * @param {string} params.game
 * @param {string} params.contentType
 * @returns {Promise<{start_s: number, end_s: number}|null>}
 */
async function _estimateHighlightWindow({ clipTitle, durationSec, game, contentType }) {
  if (!GEMINI_API_KEY) return null;
  if (durationSec <= 20) return null; // too short to bother trimming

  const prompt = `You are a video editor. Given a Twitch clip's metadata, estimate the primary highlight window (the most exciting segment to keep).

Clip title: "${clipTitle}"
Total duration: ${durationSec}s
Game/content: ${game || contentType || 'gaming'}

Rules:
- Gaming clips often have dead time at the start (loading, walking) and end (buy phase, cooldown after the play)
- The highlight is usually 10-20 seconds for gaming clips
- If the clip is entirely exciting action, return the full duration
- Return ONLY a JSON object: {"start_s": X, "end_s": Y, "confidence": "high|medium|low", "reason": "short reason"}
- start_s and end_s must be within [0, ${durationSec}]
- Minimum highlight duration: 8 seconds
- Only trim if you are confident dead time exists (confidence: high or medium)
- If unsure, return {"start_s": 0, "end_s": ${durationSec}, "confidence": "low", "reason": "no clear trim point"}`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      }
    );
    const json    = await resp.json();
    const raw     = json?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed  = JSON.parse(cleaned);

    if (!parsed || typeof parsed.start_s !== 'number' || typeof parsed.end_s !== 'number') {
      return null;
    }
    if (parsed.confidence === 'low') return null;

    const start = Math.max(0, Math.floor(parsed.start_s));
    const end   = Math.min(durationSec, Math.ceil(parsed.end_s));
    if (end - start < 8) return null;

    return { start_s: start, end_s: end, reason: parsed.reason || '' };
  } catch {
    return null;
  }
}

/**
 * Trim the assembled video to the highlight window using ffmpeg.
 *
 * @param {string} videoPath  input path (will be replaced in-place)
 * @param {number} startSec
 * @param {number} durationSec
 * @param {string} jobId
 */
async function _trimVideo(videoPath, startSec, durationSec, jobId) {
  const ext    = path.extname(videoPath);
  const tmpOut = videoPath.replace(ext, `_trimmed${ext}`);

  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath(),
      [
        '-ss',    String(startSec),
        '-i',     videoPath,
        '-t',     String(durationSec),
        '-c:v',   'libx264',
        '-preset', 'veryfast',
        '-crf',   '24',
        '-c:a',   'aac',
        '-movflags', '+faststart',
        '-y',     tmpOut,
      ],
      { timeout: 120000 },
      (err) => {
        if (err) return reject(new Error(`ffmpeg highlight trim failed: ${err.message}`));
        try {
          fs.renameSync(tmpOut, videoPath);
        } catch (renameErr) {
          return reject(renameErr);
        }
        console.log(`[highlight_trim_ext] ${jobId}: trimmed ${startSec}s–${startSec + durationSec}s → ${videoPath}`);
        resolve();
      }
    );
  });
}

/**
 * Extension entry point.
 *
 * @param {object} jobSpec
 * @param {string} jobId
 * @returns {Promise<{passed: boolean, outcome: string}>}
 */
async function runWorker(jobSpec, jobId) {
  if (!isFeatureEnabled('portal.highlight_trim', jobSpec.planTier)) {
    return { passed: true, outcome: 'skip', reason: 'portal.highlight_trim not enabled for plan' };
  }

  // Only run on ENHANCE single-clip jobs
  const contentFlow   = jobSpec.contentFlow || jobSpec.order?.contentFlow || '';
  const sourceClips   = jobSpec.order?.inputs?.clips || jobSpec.sourceClips || [];
  const clipCount     = Array.isArray(sourceClips) ? sourceClips.length : (jobSpec.clipsCount || 0);

  if (contentFlow !== 'enhance' || clipCount !== 1) {
    return { passed: true, outcome: 'skip', reason: 'not a single-clip ENHANCE job' };
  }

  const assembledPath = jobSpec.assembledPath || jobSpec.outputPath;
  if (!assembledPath || !fs.existsSync(assembledPath)) {
    return { passed: true, outcome: 'skip', reason: 'no local assembled video path' };
  }

  // Get clip metadata from job spec
  const clip       = Array.isArray(sourceClips) ? sourceClips[0] : null;
  const clipTitle  = clip?.title || jobSpec.order?.inputs?.topic || '';
  const durationSec = clip?.duration_s || clip?.duration || 0;

  if (!durationSec || durationSec <= 20) {
    return { passed: true, outcome: 'skip', reason: `clip too short to trim (${durationSec}s)` };
  }

  const game = jobSpec.order?.inputs?.game ||
    (Array.isArray(jobSpec.order?.publish?.platforms) ? '' : '') || '';

  console.log(`[highlight_trim_ext] ${jobId}: analysing highlight window for "${clipTitle}" (${durationSec}s)`);

  const window = await _estimateHighlightWindow({
    clipTitle,
    durationSec,
    game,
    contentType: jobSpec.contentType || 'clips',
  });

  if (!window) {
    return { passed: true, outcome: 'skip', reason: 'Gemini could not identify a clear trim window' };
  }

  const trimDuration   = window.end_s - window.start_s;
  const savedSec       = durationSec - trimDuration;
  const savedPct       = savedSec / durationSec;

  if (savedPct < 0.15) {
    return { passed: true, outcome: 'skip', reason: `trim saves only ${Math.round(savedPct * 100)}% — not worth it` };
  }

  console.log(`[highlight_trim_ext] ${jobId}: trimming ${window.start_s}s–${window.end_s}s (saves ${Math.round(savedPct * 100)}% — ${window.reason})`);

  try {
    await _trimVideo(assembledPath, window.start_s, trimDuration, jobId);
    return {
      passed:      true,
      outcome:     'trimmed',
      trimWindow:  window,
      savedSeconds: savedSec,
    };
  } catch (err) {
    console.warn(`[highlight_trim_ext] ${jobId}: trim failed (non-fatal) — ${err.message}`);
    return { passed: true, outcome: 'skip', reason: err.message };
  }
}

function isPass(result) {
  return result?.passed === true;
}

module.exports = { runWorker, isPass };
