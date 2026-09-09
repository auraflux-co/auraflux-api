'use strict';

/**
 * CPD-1268 — Public YouTube "Most Replayed" heatmap via yt-dlp (no download).
 * Official Analytics retention is owner-only; this works on other creators' VODs
 * when YouTube has published heat markers (often missing on very fresh livestreams).
 */

const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_CLIP_SEC = 45;
const DEFAULT_MAX_PEAKS = 8;
const DEFAULT_MIN_GAP_SEC = 90;
const DEFAULT_MIN_VALUE = 0.12;

function isYoutubeUrl(url) {
  return /youtube\.com|youtu\.be/i.test(String(url || ''));
}

function extractYoutubeVideoId(url) {
  const s = String(url || '');
  const m = s.match(/[?&]v=([^&#]+)/i)
    || s.match(/youtu\.be\/([^?&#]+)/i)
    || s.match(/youtube\.com\/shorts\/([^?&#]+)/i)
    || s.match(/youtube\.com\/live\/([^?&#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function ytdlpBin() {
  return process.env.YTDLP_PATH || 'yt-dlp';
}

/**
 * Fetch heatmap metadata only (skip media download).
 * @returns {{ ok: boolean, heatmap?: Array<{start_time:number,end_time:number,value:number}>, videoId?: string, reason?: string, message?: string }}
 */
function fetchYoutubeHeatmap(vodUrl, opts = {}) {
  const url = String(vodUrl || '').trim();
  if (!url || !isYoutubeUrl(url)) {
    return Promise.resolve({ ok: false, reason: 'not_youtube', message: 'Not a YouTube URL' });
  }
  const timeoutMs = Number(opts.timeoutMs) || 45000;
  const videoId = extractYoutubeVideoId(url);

  return new Promise((resolve) => {
    const args = ['--no-update', '--skip-download', '--print', '%(heatmap)j', url];
    if (process.env.YTDLP_PROXY) {
      args.unshift('--proxy', process.env.YTDLP_PROXY);
    }
    const child = spawn(ytdlpBin(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      resolve({ ok: false, reason: 'timeout', message: 'yt-dlp heatmap timed out', videoId });
    }, timeoutMs);

    child.stdout.on('data', (buf) => { stdout += buf.toString(); });
    child.stderr.on('data', (buf) => { stderr += buf.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'spawn_error', message: err.message, videoId });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const raw = stdout.trim().split('\n').filter(Boolean).pop() || '';
      if (!raw || raw === 'NA' || raw === 'null' || raw === 'None') {
        resolve({
          ok: false,
          reason: 'no_heatmap',
          message: 'Most Replayed heatmap not published yet (common on fresh livestreams)',
          videoId,
          stderr: stderr.slice(-300),
        });
        return;
      }
      try {
        const heatmap = JSON.parse(raw);
        if (!Array.isArray(heatmap) || !heatmap.length) {
          resolve({ ok: false, reason: 'no_heatmap', message: 'Empty heatmap', videoId });
          return;
        }
        const normalized = heatmap
          .map((p) => ({
            start_time: Number(p.start_time),
            end_time: Number(p.end_time),
            value: Number(p.value),
          }))
          .filter((p) => Number.isFinite(p.start_time) && Number.isFinite(p.end_time) && Number.isFinite(p.value));
        if (!normalized.length) {
          resolve({ ok: false, reason: 'no_heatmap', message: 'Heatmap parse produced no points', videoId });
          return;
        }
        resolve({ ok: true, heatmap: normalized, videoId, pointCount: normalized.length });
      } catch (err) {
        resolve({
          ok: false,
          reason: 'parse_error',
          message: err.message,
          videoId,
          rawPreview: raw.slice(0, 120),
        });
      }
    });
  });
}

/**
 * Local maxima on public Most Replayed curve → absolute timestamps.
 */
function findHeatmapPeaks(heatmap, opts = {}) {
  const maxPeaks = opts.maxPeaks || DEFAULT_MAX_PEAKS;
  const minGapSec = opts.minGapSec || DEFAULT_MIN_GAP_SEC;
  const minValue = opts.minValue != null ? opts.minValue : DEFAULT_MIN_VALUE;
  if (!Array.isArray(heatmap) || heatmap.length < 3) return [];

  const peaks = [];
  for (let i = 1; i < heatmap.length - 1; i++) {
    const prev = heatmap[i - 1].value;
    const cur = heatmap[i].value;
    const next = heatmap[i + 1].value;
    if (cur >= prev && cur >= next && cur >= minValue) {
      peaks.push({ ...heatmap[i], index: i });
    }
  }

  // Always include global max even if flat / edge
  const globalMax = heatmap.reduce((best, p, i) => (p.value > best.value ? { ...p, index: i } : best), {
    value: -1,
    index: -1,
  });
  if (globalMax.index >= 0 && !peaks.some((p) => p.index === globalMax.index)) {
    peaks.push(globalMax);
  }

  peaks.sort((a, b) => b.value - a.value);
  const picked = [];
  for (const p of peaks) {
    if (picked.some((x) => Math.abs(x.start_time - p.start_time) < minGapSec)) continue;
    picked.push(p);
    if (picked.length >= maxPeaks) break;
  }
  return picked.sort((a, b) => a.start_time - b.start_time);
}

/**
 * Map heatmap peaks → clip windows for Composer / staging.
 * @param {Array} heatmap
 * @param {{ clipSec?: number, maxPeaks?: number, minGapSec?: number, minValue?: number, durationSec?: number }} opts
 */
function heatmapToSegments(heatmap, opts = {}) {
  const clipSec = Math.max(15, Number(opts.clipSec) || DEFAULT_CLIP_SEC);
  const durationSec = Number(opts.durationSec) || 0;
  const peaks = findHeatmapPeaks(heatmap, opts);

  return peaks.map((p, i) => {
    const mid = (Number(p.start_time) + Number(p.end_time)) / 2;
    // Bias slightly earlier so the peak lands mid-clip (reaction setup → climax)
    let start = Math.max(0, Math.floor(mid - clipSec * 0.35));
    let end = Math.floor(start + clipSec);
    if (durationSec > 0 && end > durationSec) {
      end = Math.floor(durationSec);
      start = Math.max(0, end - clipSec);
    }
    const mm = Math.floor(start / 60);
    const ss = String(start % 60).padStart(2, '0');
    return {
      start_sec: start,
      end_sec: end,
      score: Math.round(Number(p.value) * 1000) / 1000,
      title: `Most replayed #${i + 1} @ ${mm}:${ss}`,
      summary: `YouTube Most Replayed peak (value ${Number(p.value).toFixed(3)})`,
      source: 'youtube_heatmap',
      peak_start_sec: Math.floor(p.start_time),
      peak_end_sec: Math.floor(p.end_time),
      peak_value: Number(p.value),
    };
  });
}

module.exports = {
  isYoutubeUrl,
  extractYoutubeVideoId,
  fetchYoutubeHeatmap,
  findHeatmapPeaks,
  heatmapToSegments,
  DEFAULT_CLIP_SEC,
  DEFAULT_MAX_PEAKS,
};
