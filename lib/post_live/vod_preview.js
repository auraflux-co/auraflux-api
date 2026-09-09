'use strict';

const fs = require('fs');
const path = require('path');
const { extractVodClips } = require('../assembly_service');

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');

function previewFilename(videoId, startS, endS) {
  return `postlive_${String(videoId).replace(/[^a-zA-Z0-9_-]/g, '')}_${Math.floor(startS)}_${Math.floor(endS)}.mp4`;
}

function previewFilePath(videoId, startS, endS) {
  return path.join(TMP_DIR, previewFilename(videoId, startS, endS));
}

/**
 * Extract a VOD window using the same production path as COMPACT/EXTRACT jobs
 * (extractVodClips → android/mweb). No cookie-first Peaks detour.
 */
async function extractPreviewWithYtdlp({ vodUrl, dest, startS, endS, jobId }) {
  const [extracted] = await extractVodClips(vodUrl, {
    clipCount: 1,
    maxClipSecs: Math.max(15, Math.floor(endS - startS)),
    jobId: jobId || `preview_${Date.now()}`,
    isVertical: false,
    vodClipTimestamps: [{ start_s: startS, end_s: endS, title: 'preview' }],
  });
  if (!extracted || !fs.existsSync(extracted)) {
    throw new Error('extractVodClips returned no file');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(extracted, dest);
  try { fs.unlinkSync(extracted); } catch (_) { /* ignore */ }
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 10000) {
    throw new Error('yt-dlp section download returned no file');
  }
}

/**
 * Extract (or return cached) MP4 for a VOD timestamp window.
 * Served via GET /download/:file (checks tmp/).
 */
async function getOrExtractPreviewMp4({ videoId, vodUrl, start_s, end_s }) {
  if (!videoId || !vodUrl) throw new Error('videoId and vodUrl required');
  const startS = Number(start_s);
  const endS = Number(end_s);
  if (!Number.isFinite(startS) || !Number.isFinite(endS) || endS <= startS) {
    throw new Error('Invalid start_s/end_s');
  }
  if (endS - startS > 120) {
    throw new Error('Preview window max 120s');
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const filename = previewFilename(videoId, startS, endS);
  const dest = previewFilePath(videoId, startS, endS);

  if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) {
    return { filename, previewUrl: `/download/${filename}`, cached: true, durationSec: endS - startS };
  }

  const jobId = `postlive_prev_${videoId}_${startS}`;
  await extractPreviewWithYtdlp({ vodUrl, dest, startS, endS, jobId });

  return {
    filename,
    previewUrl: `/download/${filename}`,
    cached: false,
    durationSec: endS - startS,
    method: 'extractVodClips',
  };
}

module.exports = {
  TMP_DIR,
  previewFilename,
  previewFilePath,
  extractPreviewWithYtdlp,
  getOrExtractPreviewMp4,
};
