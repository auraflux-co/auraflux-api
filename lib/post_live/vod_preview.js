'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { extractVodClips } = require('../assembly_service');

const TMP_DIR = path.join(__dirname, '..', '..', 'tmp');

function previewFilename(videoId, startS, endS) {
  return `postlive_${String(videoId).replace(/[^a-zA-Z0-9_-]/g, '')}_${Math.floor(startS)}_${Math.floor(endS)}.mp4`;
}

function previewFilePath(videoId, startS, endS) {
  return path.join(TMP_DIR, previewFilename(videoId, startS, endS));
}

function formatYtdlpSection(startS, endS) {
  const toHms = (s) => {
    const sec = Math.max(0, Math.floor(s));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };
  return `*${toHms(startS)}-${toHms(endS)}`;
}

function ytdlpAuthArgs(vodUrl, jobId) {
  const isYouTube = /youtube\.com|youtu\.be/.test(vodUrl);
  const extraArgs = [];
  let cookieFilePath = null;

  const proxyUrl = process.env.YTDLP_PROXY;
  if (proxyUrl) {
    extraArgs.push('--proxy', proxyUrl);
  } else if (isYouTube) {
    const cookiesB64 = process.env.YOUTUBE_COOKIES_BASE64;
    if (cookiesB64) {
      cookieFilePath = path.join(TMP_DIR, `yt_cookies_${jobId}.txt`);
      fs.writeFileSync(cookieFilePath, Buffer.from(cookiesB64, 'base64').toString('utf8'));
      extraArgs.push('--cookies', cookieFilePath);
    } else {
      extraArgs.push('--extractor-args', 'youtube:player_client=android,ios');
    }
  }

  return { extraArgs, cookieFilePath };
}

/**
 * Fast preview path: yt-dlp --download-sections (no ffmpeg re-encode).
 */
async function extractPreviewWithYtdlp({ vodUrl, dest, startS, endS, jobId }) {
  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  const { extraArgs, cookieFilePath } = ytdlpAuthArgs(vodUrl, jobId);
  const section = formatYtdlpSection(startS, endS);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        ytdlp,
        [
          // CPD-1274: force AVC mp4 ladder (1080→720→480). Progressive "best" often sticks at 360p.
          '--format', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=480][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720]/best',
          '--download-sections', section,
          '--force-keyframes-at-cuts',
          '--output', dest,
          '--no-playlist',
          '--no-warnings',
          '--merge-output-format', 'mp4',
          ...extraArgs,
          vodUrl,
        ],
        { timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
        (err) => {
          if (err) return reject(new Error(`yt-dlp section download failed: ${err.message.slice(0, 200)}`));
          resolve();
        },
      );
    });
  } finally {
    if (cookieFilePath) {
      try { fs.unlinkSync(cookieFilePath); } catch (_) {}
    }
  }

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
  let usedYtdlp = false;

  try {
    await extractPreviewWithYtdlp({ vodUrl, dest, startS, endS, jobId });
    usedYtdlp = true;
  } catch (ytdlpErr) {
    console.warn(`[post-live/preview] ${videoId} yt-dlp sections failed (${ytdlpErr.message}) — falling back to ffmpeg extract`);
    const [extracted] = await extractVodClips(vodUrl, {
      clipCount: 1,
      maxClipSecs: Math.max(15, endS - startS),
      jobId,
      isVertical: false,
      vodClipTimestamps: [{ start_s: startS, end_s: endS, title: 'preview' }],
    });
    if (!extracted || !fs.existsSync(extracted)) {
      throw new Error('Preview extract failed — check YOUTUBE_COOKIES_BASE64 or YTDLP_PROXY');
    }
    fs.copyFileSync(extracted, dest);
    try { fs.unlinkSync(extracted); } catch (_) {}
  }

  return {
    filename,
    previewUrl: `/download/${filename}`,
    cached: false,
    durationSec: endS - startS,
    method: usedYtdlp ? 'ytdlp-sections' : 'ffmpeg',
  };
}

module.exports = {
  TMP_DIR,
  previewFilename,
  previewFilePath,
  getOrExtractPreviewMp4,
  extractPreviewWithYtdlp,
  formatYtdlpSection,
};
