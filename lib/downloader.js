'use strict';
// lib/downloader.js
// Moved from server.js during module split — used by lib/script_gen.js and lib/assembly.js
const fs = require('fs');
const { execFile } = require('child_process');
const axios = require('axios');
const { ffmpegPath } = require('./ffmpeg_utils');

const TRUSTED_DOMAINS = [
  'localhost',                      // local dev + synthetic test clips
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
  'aljazeera.net',                // Al Jazeera CDN
  'service-pkgespn.akamaized.net', // ESPN Akamai HLS (NBA highlights)
  'media.video-cdn.espn.com',     // ESPN direct CDN (fallback)
  'akamaized.net',                // Akamai CDN (catch-all for ESPN/other Akamai)
  'googlevideo.com',              // YouTube/Google Video CDN (BBC, AP, Reuters clips)
  'youtube.com',                  // YouTube direct
  'youtu.be',                     // YouTube short URLs
  'bbc.co.uk',                    // BBC direct
  'bbc.com',                      // BBC CDN
  'reuters.com',                  // Reuters direct
  'apnews.com',                   // AP News direct
  'ap.org'                        // AP CDN
];

async function downloadFile(url, destPath) {
  // Local absolute path — synth prebuild files, skip domain check and copy directly
  if (url.startsWith('/') && fs.existsSync(url)) {
    await fs.promises.copyFile(url, destPath);
    return destPath;
  }

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

/**
 * Download a video for Gemini analysis, trimming to maxSecs to stay under the 34MB upload limit.
 * HLS streams are piped through FFmpeg with -t to cap duration before writing to disk.
 */
async function downloadVideoForAnalysis(url, destPath, { maxSecs = 90 } = {}) {
  const isTrusted = TRUSTED_DOMAINS.some(domain => url.includes(domain));
  if (!isTrusted) throw new Error(`URL blocked: not from trusted domain. URL: ${url.slice(0, 100)}`);

  const isHls = /\.m3u8(\?|$)/i.test(url) || /\/hls\//i.test(url) || /manifest\.prod/i.test(url);

  return new Promise((res, rej) => {
    const args = [
      '-i', url,
      '-t', String(maxSecs),
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      '-y', destPath
    ];
    const proc = execFile(ffmpegPath(), args, { timeout: (maxSecs + 60) * 1000, maxBuffer: 50 * 1024 * 1024 });
    proc.on('close', code => {
      if (code !== 0) return rej(new Error(`FFmpeg download failed (code ${code}) for ${url.slice(0, 80)}`));
      const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
      if (size < 1000) return rej(new Error(`Downloaded file too small (${size} bytes) — stream may be unavailable`));
      res();
    });
    proc.on('error', rej);
  });
}

module.exports = { downloadFile, downloadVideoForAnalysis };
