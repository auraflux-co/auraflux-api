'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const FFMPEG_FULL_MAC = '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';

let _cached;

function ffmpegHasDrawtext(bin) {
  try {
    const filters = execFileSync(bin, ['-filters'], { encoding: 'utf8', timeout: 8000 });
    return String(filters).includes(' drawtext ');
  } catch {
    return false;
  }
}

/** Live grid compositor/slate overlays require drawtext — Homebrew ffmpeg often lacks it. */
function resolveLiveGridFfmpeg() {
  if (_cached) return _cached;
  if (process.env.FFMPEG_PATH) {
    _cached = process.env.FFMPEG_PATH;
    return _cached;
  }
  const candidates = [
    process.platform === 'darwin' ? FFMPEG_FULL_MAC : null,
    'ffmpeg',
  ].filter(Boolean);
  for (const bin of candidates) {
    if (bin !== 'ffmpeg' && !fs.existsSync(bin)) continue;
    if (ffmpegHasDrawtext(bin)) {
      _cached = bin;
      return _cached;
    }
  }
  _cached = 'ffmpeg';
  return _cached;
}

module.exports = { resolveLiveGridFfmpeg, FFMPEG_FULL_MAC };
