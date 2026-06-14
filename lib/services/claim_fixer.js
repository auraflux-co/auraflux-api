/**
 * Claim fixer (CPD-980) — mute Content-ID-claimed timestamp ranges on a
 * produced video and republish it to YouTube as a new upload.
 *
 * Why: YouTube's Erase Song is the only in-place tool (no public API), takes
 * roughly the video's duration to process, and locks the Studio editor while
 * it runs. For videos we hold sources for, muting locally and re-uploading
 * takes minutes. Trade-off (operator's call): the republished copy is a NEW
 * video ID — views/watch hours on the claimed copy don't transfer. Worth it
 * for fresh uploads only; old videos should still use Erase Song.
 *
 * The video stream is copied untouched (-c:v copy); only audio re-encodes,
 * so the mute pass is I/O-bound and fast.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ffmpegPath } = require('../ffmpeg_utils');

/** "1:02:03" | "12:34" | "754" → seconds. Returns NaN on garbage. */
function parseTimestamp(str) {
  const parts = String(str || '').trim().split(':').map(p => p.trim());
  if (!parts.length || parts.some(p => p === '' || !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/**
 * Parse the operator's claim-range string, e.g. "12:34-13:10, 45:00-45:40".
 * Accepts mm:ss, h:mm:ss, or raw seconds on either side of the dash.
 * @returns {Array<{start:number,end:number}>} sorted, validated
 * @throws on empty/invalid input — the operator should see exactly what's wrong
 */
function parseTimeRanges(input) {
  const chunks = String(input || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!chunks.length) throw new Error('no ranges given — expected e.g. "12:34-13:10, 45:00-45:40"');
  const ranges = chunks.map(chunk => {
    const m = chunk.split(/\s*-\s*/);
    if (m.length !== 2) throw new Error(`bad range "${chunk}" — expected start-end`);
    const start = parseTimestamp(m[0]);
    const end = parseTimestamp(m[1]);
    if (Number.isNaN(start) || Number.isNaN(end)) throw new Error(`bad timestamp in "${chunk}"`);
    if (end <= start) throw new Error(`range "${chunk}" ends before it starts`);
    return { start, end };
  });
  return ranges.sort((a, b) => a.start - b.start);
}

/** ffmpeg audio filter muting all given ranges (enable expr is boolean-ish: sum of betweens). */
function buildMuteFilter(ranges) {
  const expr = ranges.map(r => `between(t,${r.start},${r.end})`).join('+');
  return `volume=enable='${expr}':volume=0`;
}

/**
 * Produce a copy of `input` (local path or URL — ffmpeg reads https directly)
 * with the given ranges muted. Video stream copied, audio re-encoded.
 */
function muteRanges(input, output, ranges, { timeoutMs = 20 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath() || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-af', buildMuteFilter(ranges),
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', output,
    ], { timeout: timeoutMs }, (err, _so, se) => {
      if (err) return reject(new Error(`mute pass failed: ${String(se || err.message).slice(0, 300)}`));
      if (!fs.existsSync(output) || !fs.statSync(output).size) return reject(new Error('mute pass produced no output'));
      resolve(output);
    });
  });
}

/**
 * Full flow: mute ranges on the job's final video and republish to YouTube.
 * @param {Object} p
 *   card     — persisted job card (driveUrl, title, publishPrep, thumbnailDriveUrl)
 *   ranges   — parsed [{start,end}]
 *   tmpDir   — where the muted copy is written
 *   log      — fn(msg)
 * @returns {Promise<{videoId:string, url:string, mutedPath:string}>}
 */
async function muteAndRepublish({ card, ranges, tmpDir, log = console.log }) {
  if (!card?.driveUrl) throw new Error('job has no driveUrl — no final video to fix');
  const yt = require('./youtube_direct');

  fs.mkdirSync(tmpDir, { recursive: true });
  const mutedPath = path.join(tmpDir, `claimfix_${card.id}_${Date.now()}.mp4`);

  log(`[claim-fixer] ${card.id}: muting ${ranges.length} range(s) — ${ranges.map(r => `${r.start}s-${r.end}s`).join(', ')}`);
  await muteRanges(card.driveUrl, mutedPath, ranges);
  log(`[claim-fixer] ${card.id}: muted copy ready (${(fs.statSync(mutedPath).size / 1024 / 1024).toFixed(1)}MB) — uploading to YouTube`);

  const prep = card.publishPrep || {};
  const result = await yt.publish({
    videoSource: mutedPath,
    metadata: {
      title: prep.title || card.title || 'ClipzWorld News',
      description: prep.description || '',
      tags: [],
      privacyStatus: 'public',
    },
    thumbnailUrl: card.thumbnailDriveUrl || null,
    jobId: `claimfix:${card.id}`,
  });
  log(`[claim-fixer] ${card.id}: ✅ republished → ${result.url}`);
  return { videoId: result.videoId, url: result.url, mutedPath };
}

module.exports = { parseTimestamp, parseTimeRanges, buildMuteFilter, muteRanges, muteAndRepublish };
