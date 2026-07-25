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

async function downloadWithYtdlp(url, outPath, { log = console.log, timeoutMs = 120000 } = {}) {
  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  const extraArgs = [];
  const proxyUrl = process.env.YTDLP_PROXY;
  if (proxyUrl) {
    extraArgs.push('--proxy', proxyUrl);
  } else if (isYouTubeUrl(url)) {
    extraArgs.push('--extractor-args', 'youtube:player_client=ANDROID_VR,ANDROID,tv_embedded');
  }
  log(`[media-download] yt-dlp → ${url.slice(0, 80)}`);
  await execFileAsync(ytdlp, [
    '--format', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720]/best',
    '--output', outPath,
    '--no-playlist',
    '--no-warnings',
    '--merge-output-format', 'mp4',
    ...extraArgs,
    url,
  ], { timeout: timeoutMs });
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 500) {
    throw new Error('yt-dlp download produced empty file');
  }
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
};
