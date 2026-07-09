'use strict';

const { execFile } = require('child_process');

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

/** Probe duration via yt-dlp (YouTube, Twitch VOD, etc.). */
async function probeVodDuration(vodUrl) {
  const out = await execFileAsync('yt-dlp', ['--dump-json', '--no-download', vodUrl], { timeout: 60000 });
  const meta = JSON.parse(out.split('\n').find((l) => l.startsWith('{')) || out);
  return {
    durationSec: Number(meta.duration) || 0,
    title: meta.title || '',
    videoId: meta.id || null,
  };
}

function detectPlatform(vodUrl) {
  const u = String(vodUrl || '').toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/twitch\.tv/.test(u)) return 'twitch';
  return 'youtube';
}

function clampRange(rangeStart, rangeEnd, durationSec) {
  const dur = Math.max(Number(durationSec) || 3600, 1);
  let start = Math.max(0, Number(rangeStart) || 0);
  let end = rangeEnd != null ? Number(rangeEnd) : dur;
  if (!Number.isFinite(end) || end <= 0) end = dur;
  end = Math.min(end, dur);
  if (end <= start) end = Math.min(dur, start + 300);
  return { start, end, span: end - start };
}

module.exports = {
  execFileAsync,
  probeVodDuration,
  detectPlatform,
  clampRange,
};
