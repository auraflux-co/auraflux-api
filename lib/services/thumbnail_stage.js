'use strict';
/**
 * lib/services/thumbnail_stage.js — Thumbnail approval stage orchestrator
 *
 * Manages the thumbnail approval lifecycle between Portal 4 and Portal 5.
 * Four generation paths (any or all can run):
 *   frame    — FFmpeg extracts 5 candidate frames from assembled video, scored by position
 *   vectcut  — CapCut AI thumbnail via VectCut service (VECTCUT_API_URL)
 *   designed — Puppeteer-rendered HTML template via lib/thumbnail.js
 *   custom   — Customer uploads their own image (handled by route, stored here)
 *
 * jobSpec.state.thumbnail shape:
 *   {
 *     status:      'pending' | 'approved' | 'skipped',
 *     method:      'frame' | 'vectcut' | 'designed' | 'custom' | null,
 *     selectedPath: string | null,
 *     r2Url:        string | null,
 *     candidates:  [{ index, path, offsetSeconds, score, url }],
 *     designedUrl:  string | null,
 *     initiatedAt:  ISO string,
 *     approvedAt:   ISO string | null,
 *   }
 */

const path = require('path');
const fs   = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { ffmpegPath, ffprobePath } = require('../ffmpeg_utils');
const { generateThumbnail }       = require('../thumbnail');
const { uploadFile }              = require('../storage');
const { saveJob }                 = require('../db');
const pipelineBus                 = require('../pipeline_events');
const { logError }                = require('../error_logger');

const execFileAsync = promisify(execFile);

const THUMB_TMP_DIR = path.join(__dirname, '..', '..', 'tmp', 'thumbnails');

// Percentage offsets to extract frames at (of total duration)
const FRAME_OFFSETS_PCT = [0.10, 0.25, 0.50, 0.75, 0.90];

// ─── FFmpeg helpers ──────────────────────────────────────────────────────────

async function getVideoDuration(videoPath) {
  const res = await execFileAsync(ffprobePath(), [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    videoPath,
  ]);
  // promisify resolves with { stdout, stderr } in real Node;
  // test mocks may resolve with a plain string — handle both.
  const stdout = (res && typeof res === 'object' && 'stdout' in res) ? res.stdout : String(res || '');
  const data = JSON.parse(stdout);
  return parseFloat(data.format?.duration || '0');
}

async function extractFrameAt(videoPath, offsetSeconds, outputPath) {
  await execFileAsync(ffmpegPath(), [
    '-y',
    '-ss', String(offsetSeconds),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '3',
    outputPath,
  ]);
}

// ─── Frame extraction ────────────────────────────────────────────────────────

/**
 * Extract up to 5 candidate frames from the assembled video.
 * Scores are a simple positional heuristic (midpoint preferred over intro/outro).
 *
 * @param {string} videoPath
 * @param {string} jobId
 * @returns {Promise<Array<{index, path, offsetSeconds, score}>>}
 */
async function extractCandidateFrames(videoPath, jobId) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found for frame extraction: ${videoPath}`);
  }

  if (!fs.existsSync(THUMB_TMP_DIR)) {
    fs.mkdirSync(THUMB_TMP_DIR, { recursive: true });
  }

  const duration = await getVideoDuration(videoPath);
  if (!duration || duration < 1) {
    throw new Error(`Could not read video duration from: ${videoPath}`);
  }

  const frames = [];
  for (let i = 0; i < FRAME_OFFSETS_PCT.length; i++) {
    const offset = Math.max(1, Math.floor(duration * FRAME_OFFSETS_PCT[i]));
    const framePath = path.join(THUMB_TMP_DIR, `${jobId}_frame_${i}.jpg`);
    try {
      await extractFrameAt(videoPath, offset, framePath);
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 500) {
        // Positional score: peaks at index 2 (50%), tapers at edges
        const score = parseFloat((1 - Math.abs(i - 2) / 4).toFixed(3));
        frames.push({ index: i, path: framePath, offsetSeconds: offset, score });
      }
    } catch (e) {
      logError('THUMBNAIL_FRAME_EXTRACT_FAIL', e, { jobId, offset, frameIndex: i });
    }
  }

  return frames.sort((a, b) => b.score - a.score);
}

// ─── VectCut path ────────────────────────────────────────────────────────────

/**
 * Request a CapCut AI thumbnail via the VectCut service.
 * Returns null when VECTCUT_API_URL is not configured (optional path).
 *
 * @param {Object} jobSpec
 * @returns {Promise<{path: string|null, url: string|null}>}
 */
async function generateVectcutThumbnail(jobSpec) {
  const apiUrl = process.env.VECTCUT_API_URL;
  if (!apiUrl) return { path: null, url: null };

  const jobId = jobSpec.jobId;
  const formatType = jobSpec.deliverySpec?.formatType || 'long';
  const hookText = jobSpec.state?.savedOutputs?.publishCopy?.youtube?.thumbnailTextOptions?.[0]
    || jobSpec.state?.savedOutputs?.publishCopy?.youtube?.title
    || '';

  try {
    const https = require('https');
    const http  = require('http');
    const mod   = apiUrl.startsWith('https') ? https : http;

    const payload = JSON.stringify({
      jobId,
      formatType,
      hookText,
      template: formatType === 'short' ? 'portrait' : 'landscape',
    });

    const result = await new Promise((resolve, reject) => {
      const req = mod.request(`${apiUrl}/thumbnail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`VectCut response parse error: ${body.slice(0, 100)}`)); }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    return { path: result.localPath || null, url: result.url || null };
  } catch (e) {
    logError('THUMBNAIL_VECTCUT_FAIL', e, { jobId });
    return { path: null, url: null };
  }
}

// ─── Upload candidates to storage ───────────────────────────────────────────

/**
 * Upload a local frame file to R2/Drive.
 * Returns the public URL, or null on failure (non-fatal).
 */
async function uploadCandidate(localPath, jobId, index) {
  try {
    const fileName = `thumbnail_${jobId}_frame_${index}.jpg`;
    const url = await uploadFile(localPath, fileName, { folder: `thumbnails/${jobId}` });
    return url || null;
  } catch (e) {
    logError('THUMBNAIL_CANDIDATE_UPLOAD_FAIL', e, { jobId, index });
    return null;
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Initiate the thumbnail approval stage for a job that has completed Portal 4.
 *
 * - Extracts up to 5 candidate frames from the assembled video
 * - Generates the designed (HTML-rendered) thumbnail via lib/thumbnail.js
 * - Optionally calls VectCut (when VECTCUT_API_URL is set)
 * - Sets jobSpec.state.thumbnail = { status: 'pending', candidates, ... }
 * - Persists the updated job spec to the DB
 * - Emits thumbnail:approval_needed on pipelineBus
 *
 * The portal_thumbnail_ext extension worker calls this. It always returns a
 * pass outcome (generation is complete; the async approval is customer-driven).
 *
 * @param {Object} jobSpec
 * @returns {Promise<{passed: boolean, outcome: string, thumbnail: Object}>}
 */
async function initiateApprovalStage(jobSpec) {
  const jobId = jobSpec.jobId;
  const videoPath =
    jobSpec.state?.savedOutputs?.driveUrl   // drive URL is not local - use assembledVideoPath
    || jobSpec.state?.savedOutputs?.assembledVideoPath
    || jobSpec.state?.assembledVideoPath
    || null;

  const thumbnailState = {
    status:       'pending',
    method:       null,
    selectedPath: null,
    r2Url:        null,
    candidates:   [],
    designedUrl:  null,
    vectcutUrl:   null,
    initiatedAt:  new Date().toISOString(),
    approvedAt:   null,
  };

  // Frame extraction
  if (videoPath && fs.existsSync(videoPath)) {
    try {
      const frames = await extractCandidateFrames(videoPath, jobId);
      const withUrls = await Promise.all(
        frames.map(async (f) => ({
          ...f,
          url: await uploadCandidate(f.path, jobId, f.index),
        }))
      );
      thumbnailState.candidates = withUrls;
    } catch (e) {
      logError('THUMBNAIL_FRAME_STAGE_FAIL', e, { jobId });
    }
  } else {
    console.warn(`[thumbnail_stage:${jobId}] No assembled video path — skipping frame extraction`);
  }

  // Designed thumbnail (Puppeteer / FFmpeg overlay via lib/thumbnail.js)
  try {
    const result = await generateThumbnail(jobSpec);
    if (result.ok) {
      thumbnailState.designedUrl = result.driveUrl || null;
      // Backfill designed as a pseudo-candidate for the customer to see
      thumbnailState.candidates.push({
        index: 'designed',
        path:  result.pngPath,
        offsetSeconds: null,
        score: 1.0,
        url:   result.driveUrl || null,
        method: 'designed',
      });
    }
  } catch (e) {
    logError('THUMBNAIL_DESIGNED_FAIL', e, { jobId });
  }

  // VectCut path (optional — only when VECTCUT_API_URL is set)
  const vc = await generateVectcutThumbnail(jobSpec);
  if (vc.url) {
    thumbnailState.vectcutUrl = vc.url;
    thumbnailState.candidates.push({
      index: 'vectcut',
      path:  vc.path,
      offsetSeconds: null,
      score: 1.0,
      url:   vc.url,
      method: 'vectcut',
    });
  }

  // Persist updated state
  if (!jobSpec.state) jobSpec.state = {};
  jobSpec.state.thumbnail = thumbnailState;

  try {
    await saveJob(jobId, jobSpec);
  } catch (e) {
    logError('THUMBNAIL_STATE_PERSIST_FAIL', e, { jobId });
  }

  // Notify pipeline
  try {
    pipelineBus.emit('thumbnail:approval_needed', {
      jobId,
      candidateCount: thumbnailState.candidates.length,
      candidates: thumbnailState.candidates.map((c) => ({
        index: c.index,
        url:   c.url,
        score: c.score,
        method: c.method || 'frame',
      })),
    });
  } catch (_e) { /* non-fatal */ }

  return {
    passed:    true,
    outcome:   'thumbnail_candidates_ready',
    thumbnail: thumbnailState,
  };
}

// ─── Approval / skip ─────────────────────────────────────────────────────────

/**
 * Mark a job's thumbnail as approved with the selected candidate.
 * Called from the route handler (POST /jobs/:jobId/thumbnail/approve).
 *
 * @param {Object} jobSpec
 * @param {Object} opts
 * @param {'frame'|'vectcut'|'designed'|'custom'} opts.method
 * @param {number|string|null} opts.candidateIndex  index from candidates array
 * @param {string|null} opts.r2Url  direct URL (already uploaded, e.g. custom upload)
 * @returns {Promise<Object>}  updated jobSpec.state.thumbnail
 */
async function approveThumbnail(jobSpec, { method, candidateIndex, r2Url }) {
  const jobId   = jobSpec.jobId;
  const thumb   = jobSpec.state?.thumbnail;
  if (!thumb) throw new Error(`No thumbnail state on job ${jobId} — run initiateApprovalStage first`);

  let selectedUrl = r2Url || null;
  let selectedPath = null;

  if (!selectedUrl && candidateIndex !== null && candidateIndex !== undefined) {
    const candidate = thumb.candidates.find((c) => String(c.index) === String(candidateIndex));
    if (!candidate) throw new Error(`Candidate index ${candidateIndex} not found in job ${jobId}`);
    selectedUrl  = candidate.url;
    selectedPath = candidate.path || null;
  }

  thumb.status       = 'approved';
  thumb.method       = method || 'frame';
  thumb.selectedPath = selectedPath;
  thumb.r2Url        = selectedUrl;
  thumb.approvedAt   = new Date().toISOString();

  try {
    await saveJob(jobId, jobSpec);
  } catch (e) {
    logError('THUMBNAIL_APPROVE_PERSIST_FAIL', e, { jobId });
  }

  try {
    pipelineBus.emit('thumbnail:approved', { jobId, method: thumb.method, r2Url: thumb.r2Url });
  } catch (_e) { /* non-fatal */ }

  return thumb;
}

/**
 * Skip thumbnail approval for a job (operator action).
 * Portal 5 will proceed without a thumbnail URL.
 */
async function skipThumbnailApproval(jobSpec) {
  const jobId = jobSpec.jobId;
  if (!jobSpec.state) jobSpec.state = {};
  if (!jobSpec.state.thumbnail) jobSpec.state.thumbnail = {};
  jobSpec.state.thumbnail.status     = 'skipped';
  jobSpec.state.thumbnail.approvedAt = new Date().toISOString();

  try { await saveJob(jobId, jobSpec); } catch (e) { logError('THUMBNAIL_SKIP_PERSIST_FAIL', e, { jobId }); }
  try { pipelineBus.emit('thumbnail:skipped', { jobId }); } catch (_e) {}

  return jobSpec.state.thumbnail;
}

module.exports = {
  extractCandidateFrames,
  initiateApprovalStage,
  approveThumbnail,
  skipThumbnailApproval,
  THUMB_TMP_DIR,
};
