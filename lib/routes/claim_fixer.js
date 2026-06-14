'use strict';
/**
 * lib/routes/claim_fixer.js — CPD-980
 *
 * Mute claimed timestamp ranges on a produced video then re-upload to YouTube.
 *
 * POST /job/:jobId/fix-claim
 *   body: { ranges: ["12:34-13:10", "45:00-45:40"], brandId: "..." }
 *
 * Flow:
 *   1. Locate final video via publish_results (driveUrl) or job card
 *   2. Download to tmp
 *   3. Apply volume=0 between each timestamp range (video stream copied)
 *   4. Upload as new YouTube video (same title/desc/thumbnail)
 *   5. Save a new publish_result row and return the new videoId
 *
 * Trade-off (by design): new videoId — old video's views/watch time lost.
 * Only worth it for fresh VODs. Old video deletion stays manual.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http  = require('http');
const { execFile } = require('child_process');

const router = require('express').Router();
const { persistedJobs } = require('../job_card');
const { getPublishResults, savePublishResult } = require('../db/postgres');
const { loadTokens } = require('../services/token_store');
const ytAdapter = require('../publish/adapters/youtube');
const { ffmpegPath } = require('../ffmpeg_utils');
const { requireAuth } = require('../auth'); // Clerk JWT middleware — attaches req.user
const { logError } = require('../error_logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a range string "MM:SS-MM:SS" or "HH:MM:SS-HH:MM:SS" → seconds.
 * Returns { start, end } in seconds (floats).
 */
function parseRange(rangeStr) {
  const [startStr, endStr] = rangeStr.trim().split('-');
  if (!startStr || !endStr) throw new Error(`Invalid range: "${rangeStr}"`);
  return { start: timeToSec(startStr.trim()), end: timeToSec(endStr.trim()) };
}

function timeToSec(t) {
  const parts = t.split(':').map(Number);
  if (parts.some(isNaN)) throw new Error(`Invalid timestamp: "${t}"`);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error(`Unexpected timestamp format: "${t}"`);
}

/** Download a URL to a local file path. */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const dest  = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      if (res.statusCode >= 400) {
        reject(new Error(`Download HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(dest);
      dest.on('finish', resolve);
      dest.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Build an FFmpeg af (audio filter) expression that mutes each range.
 * Uses volume=0 enabled between timestamps; video stream is stream-copied.
 *
 * Example output for ranges [{start:754, end:790}]:
 *   volume=0:enable='between(t,754,790)'
 *
 * Multiple ranges are chained:
 *   volume=0:enable='between(t,734,770)',volume=0:enable='between(t,2700,2740)'
 */
function buildMuteFilter(ranges) {
  return ranges
    .map(({ start, end }) => `volume=0:enable='between(t,${start},${end})'`)
    .join(',');
}

/** Run FFmpeg with the given args and resolve on exit 0. */
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: 600000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`FFmpeg failed: ${stderr?.slice(-300) || err.message}`));
      else resolve();
    });
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /job/:jobId/fix-claim
 * body: { ranges: string[], brandId: string }
 */
router.post('/job/:jobId/fix-claim', requireAuth, async (req, res) => {
  const { jobId } = req.params;
  const { ranges, brandId } = req.body || {};

  if (!Array.isArray(ranges) || ranges.length === 0) {
    return res.status(400).json({ error: 'ranges is required (array of "MM:SS-MM:SS" strings)' });
  }
  if (!brandId) {
    return res.status(400).json({ error: 'brandId is required' });
  }

  // ── Parse ranges ──────────────────────────────────────────────────────────
  let parsedRanges;
  try {
    parsedRanges = ranges.map(parseRange);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const tmpDir = os.tmpdir();
  const inputPath  = path.join(tmpDir, `claim_fix_in_${jobId}.mp4`);
  const outputPath = path.join(tmpDir, `claim_fix_out_${jobId}.mp4`);

  try {
    // ── Locate the final video URL ────────────────────────────────────────
    const card = persistedJobs[jobId];
    let driveUrl = card?.state?.savedOutputs?.driveUrl || card?.driveUrl || null;

    if (!driveUrl) {
      // Fall back to publish_results table
      const results = await getPublishResults(jobId);
      const ytResult = results.find((r) => r.platform === 'youtube' && r.driveUrl);
      driveUrl = ytResult?.driveUrl || null;
    }
    if (!driveUrl) {
      return res.status(404).json({
        error: `No final video URL found for job ${jobId}. ` +
               'The video must have been assembled and uploaded to Drive/R2 before claim fixing.',
      });
    }

    // ── Resolve publish metadata from existing YouTube result ─────────────
    const publishResults = await getPublishResults(jobId);
    const ytPrev = publishResults.find((r) => r.platform === 'youtube');
    const title  = ytPrev?.title || card?.state?.savedOutputs?.publishCopy?.youtube?.title || card?.templateName || 'Fixed video';

    // ── Load YouTube OAuth tokens ──────────────────────────────────────────
    const customerId = req.user?.id || req.user?.sub;
    if (!customerId) return res.status(401).json({ error: 'Not authenticated' });

    const tokens = await loadTokens(customerId, brandId, 'youtube');
    if (!tokens) {
      return res.status(400).json({
        error: `No YouTube OAuth tokens for brand ${brandId}. Connect the channel in Settings first.`,
      });
    }

    // ── Download original video ───────────────────────────────────────────
    await downloadFile(driveUrl, inputPath);

    // ── Build FFmpeg mute filter ──────────────────────────────────────────
    const muteFilter = buildMuteFilter(parsedRanges);

    // FFmpeg: copy video stream, apply audio mute filter
    await runFFmpeg([
      '-i', inputPath,
      '-c:v', 'copy',
      '-af', muteFilter,
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', outputPath,
    ]);

    // ── Re-upload to YouTube ──────────────────────────────────────────────
    const jobSpec = {
      jobId,
      customerId,
      brandId,
      planTier: card?.planTier || 'operate',
      publishCopy: card?.state?.savedOutputs?.publishCopy || {},
      templateName: card?.templateName,
    };

    const ytResult = await ytAdapter.publish({
      videoPath: outputPath,
      metadata: {
        title,
        description: card?.state?.savedOutputs?.publishCopy?.youtube?.description || '',
        privacyStatus: 'public',
      },
      tokens,
      jobSpec,
    });

    // ── Persist the new publish result ────────────────────────────────────
    await savePublishResult(jobId, 'youtube', {
      platformJobId: ytResult.platformJobId,
      driveUrl: ytResult.url,
      title,
      status: 'published',
    });

    return res.json({
      ok: true,
      newVideoId: ytResult.platformJobId,
      url: ytResult.url,
      rangesMuted: parsedRanges.length,
      message: `Video re-uploaded with ${parsedRanges.length} range(s) muted. New YouTube ID: ${ytResult.platformJobId}`,
    });

  } catch (err) {
    logError('CLAIM_FIX_ERROR', err, { jobId });
    return res.status(500).json({ error: err.message });
  } finally {
    // Clean up tmp files
    try { if (fs.existsSync(inputPath))  fs.unlinkSync(inputPath);  } catch (_) {}
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
  }
});

module.exports = router;
