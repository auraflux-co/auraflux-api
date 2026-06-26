'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function resolveVodStreamUrl(vodUrl) {
  const out = await execFileAsync('yt-dlp', ['-g', '-f', 'best[height<=480]/best', vodUrl], { timeout: 45000 });
  const url = out.split('\n').find((line) => line.startsWith('http'));
  if (!url) throw new Error('yt-dlp returned no stream URL');
  return url;
}

async function extractFrameAt(streamUrl, sec, outPath) {
  await execFileAsync('ffmpeg', [
    '-y', '-ss', String(sec), '-i', streamUrl,
    '-frames:v', '1', '-q:v', '4', outPath,
  ], { timeout: 90000 });
}

/**
 * Spread up to maxFrames JPEG samples across a VOD for Gemini multimodal analysis.
 */
async function sampleVodFrames({ vodUrl, durationSec, maxFrames = 8, log = console.log }) {
  const dur = Math.max(Number(durationSec) || 3600, 60);
  const n = Math.min(Math.max(maxFrames, 1), 8);
  const streamUrl = await resolveVodStreamUrl(vodUrl);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vod-frames-'));
  const frames = [];
  try {
    for (let i = 0; i < n; i++) {
      const sec = Math.floor((dur * (i + 0.5)) / n);
      const outPath = path.join(tmpDir, `frame_${i}.jpg`);
      try {
        await extractFrameAt(streamUrl, sec, outPath);
        const buf = fs.readFileSync(outPath);
        frames.push({ sec, data: buf.toString('base64'), mimeType: 'image/jpeg' });
      } catch (e) {
        log(`[vod-frames] skip frame at ${sec}s: ${e.message}`);
      }
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
  if (!frames.length) throw new Error('No frames extracted from VOD');
  return frames;
}

module.exports = {
  sampleVodFrames,
  resolveVodStreamUrl,
};
