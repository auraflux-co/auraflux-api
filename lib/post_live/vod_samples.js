'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { analyzableWindows, secToHms } = require('./time_ranges');
const { extractPreviewWithYtdlp, TMP_DIR } = require('./vod_preview');
const { ffmpegPath } = require('../ffmpeg_utils');

function sampleConfig() {
  return {
    count: Math.max(2, Math.min(10, Number(process.env.POST_LIVE_VOD_SAMPLE_COUNT) || 6)),
    sampleSec: Math.max(45, Math.min(120, Number(process.env.POST_LIVE_VOD_SAMPLE_SECS) || 90)),
    refCompSec: Math.max(20, Math.min(90, Number(process.env.POST_LIVE_REF_COMP_SECS) || 45)),
  };
}

/**
 * Pick sample windows: retention peaks first, then evenly-spread fill.
 */
function pickVodSampleWindows(durationSec, skipRanges, opts = {}) {
  const { count = 6, sampleSec = 90, retentionPeaks = [] } = { ...sampleConfig(), ...opts };
  const windows = analyzableWindows(0, durationSec, skipRanges || []);
  const picked = [];

  function inWindow(startS) {
    if (startS < 0 || startS + sampleSec > durationSec) return false;
    for (const ex of skipRanges || []) {
      if (startS >= ex.start && startS < ex.end) return false;
      if (startS + sampleSec > ex.start && startS < ex.end) return false;
    }
    return windows.some((w) => startS >= w.start && startS + sampleSec <= w.end + 5);
  }

  function tryAdd(sample) {
    if (picked.some((p) => Math.abs(p.start_s - sample.start_s) < sampleSec * 0.45)) return false;
    picked.push(sample);
    return true;
  }

  const peakBudget = Math.min(retentionPeaks.length, Math.max(2, Math.ceil(count / 2)));
  for (let i = 0; i < peakBudget; i++) {
    const peak = retentionPeaks[i];
    if (!peak) break;
    const leadIn = Math.min(20, Math.floor(sampleSec * 0.12));
    const startS = Math.max(0, peak.start_s - leadIn);
    if (!inWindow(startS)) continue;
    tryAdd({
      label: `peak_${secToHms(peak.start_s).replace(/:/g, '')}`,
      start_s: startS,
      end_s: startS + sampleSec,
      source: 'retention_peak',
      peakAt_s: peak.start_s,
      index: picked.length + 1,
    });
  }

  const candidates = [];
  for (const w of windows) {
    const span = w.end - w.start;
    if (span < sampleSec + 10) continue;
    const usableSpan = span - sampleSec;
    const chunks = Math.max(1, Math.min(3, Math.floor(span / (sampleSec * 1.5))));
    for (let c = 0; c < chunks; c++) {
      const offset = chunks === 1
        ? Math.floor(usableSpan / 2)
        : Math.floor((usableSpan * c) / Math.max(1, chunks - 1));
      const startS = Math.floor(w.start + offset);
      candidates.push({
        label: `vod_${secToHms(startS).replace(/:/g, '')}`,
        start_s: startS,
        end_s: startS + sampleSec,
        windowStart: w.start,
        windowEnd: w.end,
        source: 'spread',
      });
    }
  }

  for (let i = 0; picked.length < count && candidates.length; i++) {
    const idx = Math.min(candidates.length - 1, Math.floor((i + 0.5) * candidates.length / count));
    const c = candidates[idx];
    if (inWindow(c.start_s)) {
      tryAdd({ ...c, index: picked.length + 1 });
    }
  }

  return picked.slice(0, count).map((s, i) => ({ ...s, index: i + 1 })).sort((a, b) => a.start_s - b.start_s);
}

async function extractVodSampleFile({ vodUrl, videoId, sample, jobPrefix = 'postlive_analyze' }) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const safeId = String(videoId || 'vod').replace(/[^a-zA-Z0-9_-]/g, '');
  const dest = path.join(TMP_DIR, `${jobPrefix}_${safeId}_${sample.start_s}_${sample.end_s}.mp4`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) {
    return { ...sample, localPath: dest, cached: true };
  }
  const jobId = `${jobPrefix}_${safeId}_${sample.start_s}`;
  await extractPreviewWithYtdlp({
    vodUrl,
    dest,
    startS: sample.start_s,
    endS: sample.end_s,
    jobId,
  });
  return { ...sample, localPath: dest, cached: false };
}

async function extractRemoteVideoSnippet(videoUrl, destPath, maxSec = 45) {
  if (!videoUrl) throw new Error('videoUrl required');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await new Promise((resolve, reject) => {
    execFile(
      ffmpegPath(),
      [
        '-hide_banner', '-loglevel', 'error',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_network_error', '1',
        '-i', videoUrl,
        '-t', String(maxSec),
        '-c', 'copy',
        '-y', destPath,
      ],
      { timeout: 120000 },
      (err) => {
        if (err) return reject(new Error(`ffmpeg snippet failed: ${err.message.slice(0, 120)}`));
        resolve();
      },
    );
  });
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 10000) {
    throw new Error('snippet extract returned no file');
  }
  return destPath;
}

/**
 * Extract spread VOD samples for Gemini multimodal review.
 */
async function buildVodSampleMedia({ session, skipRanges, retentionPeaks = [], log = console.log }) {
  const durationSec = session.durationSec || 7200;
  const cfg = sampleConfig();
  const windows = pickVodSampleWindows(durationSec, skipRanges, { ...cfg, retentionPeaks });
  if (!windows.length) {
    return { samples: [], errors: ['No analyzable windows large enough for video samples'] };
  }

  const samples = [];
  const errors = [];
  for (const sample of windows) {
    try {
      log(`[post-live/analyze] extracting VOD sample ${sample.index}/${windows.length} @ ${secToHms(sample.start_s)}`);
      const extracted = await extractVodSampleFile({
        vodUrl: session.url,
        videoId: session.videoId,
        sample,
      });
      samples.push(extracted);
    } catch (e) {
      errors.push(`${secToHms(sample.start_s)}: ${e.message.slice(0, 100)}`);
      log(`[post-live/analyze] sample failed @ ${secToHms(sample.start_s)}: ${e.message.slice(0, 80)}`);
    }
  }

  return { samples, errors, config: cfg };
}

module.exports = {
  sampleConfig,
  pickVodSampleWindows,
  extractVodSampleFile,
  extractRemoteVideoSnippet,
  buildVodSampleMedia,
};
