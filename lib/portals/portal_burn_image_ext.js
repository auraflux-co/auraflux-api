'use strict';
/**
 * lib/portals/portal_burn_image_ext.js — Burn Images Extension (CPD-208)
 *
 * Overlays stat card text onto assembled video when addOns.imageBurn.active = true.
 * Uses Gemini to derive 2-3 contextually appropriate stat labels, then burns them
 * in as styled drawtext overlays using ffmpeg.
 *
 * Spec-driven: only activates when jobSpec.addOns.imageBurn.active === true.
 * Non-fatal: all errors fall back to skip (the video is not modified).
 *
 * Runs AFTER chrome overlay, BEFORE final R2 upload.
 */

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { ffmpegPath } = require('../ffmpeg_utils');
const { isFeatureEnabled } = require('../services/feature_gate');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * Use Gemini to derive 2-3 contextually relevant stat card labels from the job spec.
 * Returns null on failure — caller must handle.
 *
 * @param {object} jobSpec
 * @returns {Promise<Array<{label: string, value: string}>|null>}
 */
async function _extractStats(jobSpec) {
  if (!GEMINI_API_KEY) return null;

  const streamer    = jobSpec.order?.inputs?.streamer || jobSpec.brandName || 'Streamer';
  const game        = jobSpec.order?.inputs?.game || jobSpec.designSpec?.brief || '';
  const contentType = jobSpec.contentType || 'clips';
  const platform    = (jobSpec.order?.publish?.platforms || [])
    .map((p) => String(p).toUpperCase()).join(', ') || 'YOUTUBE';

  const prompt = `You are a video production assistant. Given this streamer clip context, suggest exactly 2 short stat card overlays to display as animated badges on the video.

Streamer: ${streamer}
Game/Content: ${game}
Content type: ${contentType}
Platform: ${platform}

Rules:
- Return a JSON array of exactly 2 objects: [{"label": "CATEGORY", "value": "TEXT"}]
- label: 1-2 words in CAPS (e.g. "KILLS", "RANK", "PLATFORM", "TOPIC")
- value: 2-8 characters max (e.g. "ACE", "D1", "YT", "LIVE")
- For gaming content: use gaming stats (KILLS, RANK, ACE, WIN, etc.)
- For non-gaming: use content metadata (LIVE, NEW, CLIP, GUEST, etc.)
- Only return the JSON array. No other text.`;

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
    const raw     = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed  = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.slice(0, 3).map((s) => ({
      label: String(s.label || 'CLIP').slice(0, 12).toUpperCase(),
      value: String(s.value || '').slice(0, 12),
    }));
  } catch (err) {
    return null;
  }
}

/**
 * Apply stat card overlays using ffmpeg drawtext.
 * Each card fades in for 3s at the bottom-left corner, staggered.
 *
 * @param {string} videoPath  input video path (modified in-place via outputPath + rename)
 * @param {string} outputPath temp output path
 * @param {Array<{label, value}>} stats
 * @param {string} jobId
 */
async function _applyStatCards(videoPath, outputPath, stats, jobId) {
  return new Promise((resolve, reject) => {
    const filters = [];

    stats.forEach((stat, i) => {
      const startSec = 1.0 + i * 3.5;
      const endSec   = startSec + 3.0;
      const yOffset  = 20 + i * 70;

      // Background box for label
      filters.push(
        `drawtext=text='${stat.label}':fontsize=18:fontcolor=white:` +
        `x=20:y=h-${yOffset + 40}:` +
        `box=1:boxcolor=black@0.65:boxborderw=6:` +
        `shadowcolor=black@0.7:shadowx=1:shadowy=1:` +
        `enable='between(t\\,${startSec}\\,${endSec})'`
      );
      // Value in gold
      filters.push(
        `drawtext=text='${stat.value}':fontsize=26:fontcolor=#FFD700@1.0:` +
        `x=20:y=h-${yOffset}:` +
        `box=1:boxcolor=black@0.65:boxborderw=8:` +
        `shadowcolor=black@0.8:shadowx=2:shadowy=2:` +
        `enable='between(t\\,${startSec}\\,${endSec})'`
      );
    });

    const vf = filters.join(',');
    console.log(`[burn_image_ext] ${jobId}: applying ${stats.length} stat cards`);

    execFile(
      ffmpegPath(),
      [
        '-i',    videoPath,
        '-vf',   vf,
        '-c:a',  'copy',
        '-c:v',  'libx264',
        '-preset', 'veryfast',
        '-crf',  '24',
        '-movflags', '+faststart',
        '-y',    outputPath,
      ],
      { timeout: 90000 },
      (err) => {
        if (err) return reject(new Error(`ffmpeg stat-card overlay failed: ${err.message}`));
        resolve();
      }
    );
  });
}

/**
 * Extension entry point — called by the pipeline when the extension is active.
 *
 * @param {object} jobSpec
 * @param {string} jobId
 * @returns {Promise<{passed: boolean, outcome: string, cards?: Array}>}
 */
async function runWorker({ jobSpec, workerAttempt = 1 } = {}) {
  const jobId = jobSpec?.jobId || 'unknown';
  if (!isFeatureEnabled('portal.burn_image', jobSpec?.planTier)) {
    return { passed: true, outcome: 'skip', reason: 'portal.burn_image not enabled for plan' };
  }
  const active = jobSpec?.addOns?.imageBurn?.active === true;
  if (!active) {
    return { passed: true, outcome: 'skip', reason: 'imageBurn not ordered' };
  }

  const videoPath = jobSpec.assembledPath || jobSpec.outputPath;
  if (!videoPath || !fs.existsSync(videoPath)) {
    console.warn(`[burn_image_ext] ${jobId}: no local video path available — skipping`);
    return { passed: true, outcome: 'skip', reason: 'no local video path' };
  }

  const stats = await _extractStats(jobSpec);
  if (!stats || stats.length === 0) {
    console.warn(`[burn_image_ext] ${jobId}: Gemini returned no stat labels — skipping`);
    return { passed: true, outcome: 'skip', reason: 'no stats from Gemini' };
  }

  const ext        = path.extname(videoPath);
  const outputPath = videoPath.replace(ext, `_burned${ext}`);

  try {
    await _applyStatCards(videoPath, outputPath, stats, jobId);
    fs.renameSync(outputPath, videoPath);
    console.log(`[burn_image_ext] ${jobId}: stat cards applied — ${JSON.stringify(stats)}`);
    return { passed: true, outcome: 'applied', cards: stats };
  } catch (err) {
    console.warn(`[burn_image_ext] ${jobId}: stat card overlay failed (non-fatal) — ${err.message}`);
    if (fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch (_) {}
    }
    return { passed: true, outcome: 'skip', reason: err.message };
  }
}

function isPass(result) {
  return result?.passed === true;
}

module.exports = { runWorker, isPass };
