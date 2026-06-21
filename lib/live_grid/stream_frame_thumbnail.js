'use strict';
/**
 * Grab a single video frame for YouTube live thumbnail (1280×720 JPEG).
 * Default source: solo/quadrant RTSP from MediaMTX after ingest is up.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveLiveGridFfmpeg } = require('./ffmpeg_path');
const { quadUrl } = require('./feeders');
const { rtspHasVideo } = require('./rtsp_probe');

const FFMPEG = resolveLiveGridFfmpeg();
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output', 'live_thumbnails');
const W = parseInt(process.env.LIVE_GRID_THUMB_W || '1280', 10);
const H = parseInt(process.env.LIVE_GRID_THUMB_H || '720', 10);

function captureWithFfmpeg(inputUrl, outPath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', inputUrl,
      '-vframes', '1',
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`,
      '-q:v', '2',
      '-y', outPath,
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ ok: false, error: 'ffmpeg timeout' });
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
        resolve({ ok: true, path: outPath });
      } else {
        resolve({ ok: false, error: err.trim().slice(0, 200) || `ffmpeg exit ${code}` });
      }
    });
  });
}

/**
 * @param {object} opts
 * @param {string} [opts.inputUrl] — RTSP/HLS/HTTP input
 * @param {number} [opts.quadrant] — 0–3 → quad RTSP when inputUrl omitted
 * @param {number} [opts.waitMs] — wait for video before capture
 */
async function captureStreamFrameThumbnail(opts = {}) {
  const inputUrl = opts.inputUrl || (Number.isInteger(opts.quadrant) ? quadUrl(opts.quadrant) : null);
  if (!inputUrl) return { ok: false, error: 'no inputUrl or quadrant' };

  const waitMs = opts.waitMs ?? parseInt(process.env.LIVE_GRID_THUMB_WAIT_MS || '8000', 10);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await rtspHasVideo(inputUrl, 4000)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `stream_frame_q${opts.quadrant ?? 'x'}_${Date.now()}.jpg`);
  return captureWithFfmpeg(inputUrl, outPath);
}

module.exports = { captureStreamFrameThumbnail, OUTPUT_DIR };
