'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const { ffmpegPath } = require('../ffmpeg_utils');

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 80 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/i.test(String(url || ''));
}

/** CPD-1312: ANDROID_VR media URLs 403; tv_embedded unsupported. android downloads. */
const YOUTUBE_PLAYER_CLIENT_ARG = 'youtube:player_client=android,ios';

function youtubeYtdlpExtraArgs(url) {
  const extraArgs = [];
  const proxyUrl = process.env.YTDLP_PROXY;
  if (proxyUrl) {
    extraArgs.push('--proxy', proxyUrl);
  } else if (isYouTubeUrl(url)) {
    extraArgs.push('--extractor-args', YOUTUBE_PLAYER_CLIENT_ARG);
  }
  return extraArgs;
}

function isDirectMediaUrl(url) {
  const s = String(url || '');
  return /\.mp4(\?|$)/i.test(s)
    || /cloudfront\.net\/nauth\//i.test(s)
    || /clips-media-assets/i.test(s);
}

function needsYtdlpDownload({ mp4Url, pageUrl, quality } = {}) {
  const input = mp4Url || pageUrl || '';
  if (!input) return false;
  if (['youtube-page-ytdlp', 'page-url-ytdlp', 'kick-page-ytdlp'].includes(quality)) return true;
  if (isYouTubeUrl(input)) return true;
  if (isDirectMediaUrl(input)) return false;
  return /twitch\.tv|kick\.com/i.test(input);
}

async function downloadWithYtdlp(url, outPath, { log = console.log, timeoutMs = 120000, retries = 3 } = {}) {
  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  const extraArgs = youtubeYtdlpExtraArgs(url);
  const fs = require('fs');
  const path = require('path');
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      log(`[media-download] yt-dlp → ${url.slice(0, 80)} (try ${attempt}/${retries})`);
      await execFileAsync(ytdlp, [
        '--format', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720]/best',
        '--output', outPath,
        '--no-playlist',
        '--no-warnings',
        '--merge-output-format', 'mp4',
        '--retries', '5',
        '--fragment-retries', '5',
        ...extraArgs,
        url,
      ], { timeout: timeoutMs });
      if (fs.existsSync(outPath) && fs.statSync(outPath).size >= 500) return;
      // Merge sometimes leaves sibling files when -o is a fixed .mp4 path
      const dir = path.dirname(outPath);
      const base = path.basename(outPath, path.extname(outPath));
      const alt = fs.readdirSync(dir)
        .filter((n) => n.startsWith(base) && /\.(mp4|mkv|webm)$/i.test(n))
        .map((n) => path.join(dir, n))
        .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
      if (alt && fs.statSync(alt).size >= 500) {
        if (alt !== outPath) fs.copyFileSync(alt, outPath);
        return;
      }
      throw new Error('yt-dlp download produced empty file');
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message || err);
      const retryable = /ECONNRESET|EPIPE|ETIMEDOUT|timed out|Unable to download|HTTP Error 5/i.test(msg);
      log(`[media-download] yt-dlp failed try ${attempt}: ${msg.slice(0, 160)}`);
      if (!retryable || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr || new Error('yt-dlp download failed');
}

/**
 * Download clip media to a local MP4 — direct CDN copy when possible, yt-dlp for page URLs.
 */
async function downloadMediaToFile({ mp4Url, pageUrl, outPath, quality, log = console.log, timeoutMs = 300000 }) {
  const input = mp4Url || pageUrl;
  if (!input) throw new Error('No clip URL to download');

  if (needsYtdlpDownload({ mp4Url, pageUrl, quality })) {
    await downloadWithYtdlp(input, outPath, { log, timeoutMs });
    log(`[media-download] saved ${Math.round(fs.statSync(outPath).size / 1024)}KB via yt-dlp`);
    return outPath;
  }

  await execFileAsync(ffmpegPath(), [
    '-y', '-i', input,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ], { timeout: timeoutMs });
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 500) {
    throw new Error('Clip download produced empty file');
  }
  log(`[media-download] saved ${Math.round(fs.statSync(outPath).size / 1024)}KB via ffmpeg copy`);
  return outPath;
}

module.exports = {
  downloadMediaToFile,
  downloadWithYtdlp,
  needsYtdlpDownload,
  isYouTubeUrl,
  isDirectMediaUrl,
  youtubeYtdlpExtraArgs,
  YOUTUBE_PLAYER_CLIENT_ARG,
};
