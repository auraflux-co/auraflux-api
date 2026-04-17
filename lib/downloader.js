'use strict';
// lib/downloader.js
// Moved from server.js during module split — used by lib/script_gen.js and lib/assembly.js
const fs = require('fs');
const { execFile } = require('child_process');
const axios = require('axios');
const { ffmpegPath } = require('./ffmpeg_utils');

const TRUSTED_DOMAINS = [
  'clips-media-assets',           // Twitch CDN
  'clips-media-assets2',          // Twitch CDN
  'production-assets',            // Twitch
  'cloudfront.net',               // AWS CloudFront (Twitch authenticated clips)
  'resource.heygencdn.com',       // HeyGen CDN
  'files2.heygen.ai',             // HeyGen temporary files
  'heygen.ai',                    // HeyGen (catch-all for subdomains)
  'storage.googleapis.com',       // Google Cloud Storage
  'drive.google.com',             // Google Drive
  'boltdns.net',                  // Brightcove CDN (Al Jazeera HLS manifests)
  'brightcove.net',               // Brightcove
  'brightcove.com',               // Brightcove
  'edge.api.brightcove.com',      // Brightcove edge API
  'aljazeera.com',                // Al Jazeera direct
  'aljazeera.net'                 // Al Jazeera CDN
];

async function downloadFile(url, destPath) {
  // SSRF Protection: Validate URL is from trusted domains
  const isTrusted = TRUSTED_DOMAINS.some(domain => url.includes(domain));
  if (!isTrusted) {
    throw new Error(`URL blocked: not from trusted domain. URL: ${url.slice(0, 100)}`);
  }

  // HLS manifest detection — route to FFmpeg instead of naive axios streaming
  // Axios would download the ~2KB text manifest, not the actual video segments
  const isHls = /\.m3u8(\?|$)/i.test(url) || /\/hls\//i.test(url);
  if (isHls) {
    return new Promise((res, rej) => {
      const args = [
        '-i', url,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart',
        '-y', destPath
      ];
      const proc = execFile(ffmpegPath(), args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
      proc.on('close', code => code === 0 ? res() : rej(new Error(`FFmpeg HLS download failed with code ${code}`)));
      proc.on('error', rej);
    });
  }

  const writer = fs.createWriteStream(destPath);
  const resp   = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
  resp.data.pipe(writer);
  return new Promise((res, rej) => {
    writer.on('finish', res);
    writer.on('error', rej);
  });
}

// downloadVideoForAnalysis — like downloadFile but with an optional maxSecs time cap.
// Used by script_gen.js and server.js when downloading clips for Gemini video analysis.
// If maxSecs is set and the URL is not HLS, uses FFmpeg -t to cap duration (avoids huge downloads).
async function downloadVideoForAnalysis(url, destPath, { maxSecs } = {}) {
  const isTrusted = TRUSTED_DOMAINS.some(domain => url.includes(domain));
  if (!isTrusted) {
    throw new Error(`URL blocked: not from trusted domain. URL: ${url.slice(0, 100)}`);
  }

  const isHls = /\.m3u8(\?|$)/i.test(url) || /\/hls\//i.test(url);

  if (isHls || maxSecs) {
    return new Promise((res, rej) => {
      const args = [
        ...(maxSecs ? ['-t', String(maxSecs)] : []),
        '-i', url,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart',
        '-y', destPath
      ];
      const proc = execFile(ffmpegPath(), args, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
      proc.on('close', code => code === 0 ? res() : rej(new Error(`FFmpeg download failed with code ${code}`)));
      proc.on('error', rej);
    });
  }

  return downloadFile(url, destPath);
}

module.exports = { downloadFile, downloadVideoForAnalysis };
