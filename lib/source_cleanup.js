'use strict';

/**
 * Blur fixed UI regions on Twitch/VOD source before layout crop (chat rail, bars).
 * Runs BEFORE portrait layout so the main crop can stay wide without losing action.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');

/** Normalised [0,1] rects on 16:9 landscape source. */
const TWITCH_UI_PRESETS = {
  chat_rail: { id: 'chat_rail', x: 0.78, y: 0, w: 0.22, h: 1 },
  bottom_bar: { id: 'bottom_bar', x: 0, y: 0.86, w: 1, h: 0.14 },
  top_bar: { id: 'top_bar', x: 0, y: 0, w: 1, h: 0.09 },
};

function norm01(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normRect(r) {
  if (!r || typeof r !== 'object') return null;
  const x = norm01(r.x);
  const y = norm01(r.y);
  const w = Math.max(0.02, Math.min(1 - x, norm01(r.w, 0.1)));
  const h = Math.max(0.02, Math.min(1 - y, norm01(r.h, 0.1)));
  return { x, y, w, h, id: r.id || 'custom' };
}

/**
 * Resolve delogo regions from compCreative.sourceCleanup.
 * @returns {Array<{ x,y,w,h,id }>} normalised rects
 */
function resolveSourceCleanupRegions(sourceCleanup = {}) {
  if (!sourceCleanup || typeof sourceCleanup !== 'object') return [];
  const sc = sourceCleanup;
  if (sc.enabled === false) return [];

  const out = [];
  const seen = new Set();

  function pushRect(rect) {
    const n = normRect(rect);
    if (!n) return;
    const key = `${n.id}:${n.x.toFixed(3)}:${n.y.toFixed(3)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  }

  if (sc.hideChatRail !== false && sc.hideChatRail) pushRect(TWITCH_UI_PRESETS.chat_rail);
  if (sc.hideBottomBar) pushRect(TWITCH_UI_PRESETS.bottom_bar);
  if (sc.hideTopBar) pushRect(TWITCH_UI_PRESETS.top_bar);

  for (const row of Array.isArray(sc.regions) ? sc.regions : []) {
    pushRect(row);
  }

  return out;
}

function regionsToDelogoFilter(regions) {
  if (!regions.length) return null;
  const parts = regions.map((r) => {
    const x = `iw*${r.x.toFixed(4)}`;
    const y = `ih*${r.y.toFixed(4)}`;
    const w = `iw*${r.w.toFixed(4)}`;
    const h = `ih*${r.h.toFixed(4)}`;
    return `delogo=x=${x}:y=${y}:w=${w}:h=${h}`;
  });
  return parts.join(',');
}

function execFfmpeg(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), args, { timeout: timeoutMs, maxBuffer: 40 * 1024 * 1024 }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Apply source UI cleanup when regions are configured.
 * @returns {Promise<string>} path to use (outputPath if filtered, else inputPath)
 */
async function applySourceCleanup(inputPath, outputPath, { compCreative = null, sourceCleanup = null, log = null } = {}) {
  if (!inputPath || !fs.existsSync(inputPath)) return inputPath;
  const cfg = sourceCleanup || compCreative?.sourceCleanup || null;
  const regions = resolveSourceCleanupRegions(cfg);
  if (!regions.length) {
    if (outputPath && path.resolve(outputPath) !== path.resolve(inputPath)) {
      fs.copyFileSync(inputPath, outputPath);
    }
    return inputPath;
  }

  const vf = regionsToDelogoFilter(regions);
  const dest = outputPath || `${inputPath}.clean.mp4`;
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  await execFfmpeg([
    '-y', '-i', inputPath,
    '-vf', vf,
    '-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    dest,
  ]);

  if (!fs.existsSync(dest) || fs.statSync(dest).size < 500) {
    throw new Error('Source cleanup encode failed');
  }
  if (log) {
    log(`[source-cleanup] ${regions.length} region(s): ${regions.map((r) => r.id).join(', ')}`);
  }
  return dest;
}

function sourceCleanupSummary(sourceCleanup = {}) {
  const regions = resolveSourceCleanupRegions(sourceCleanup);
  if (!regions.length) return '';
  return regions.map((r) => r.id.replace(/_/g, ' ')).join(' + ');
}

function mergeSourceCleanup(base = {}, patch = {}) {
  const out = { ...(base || {}) };
  if (patch && typeof patch === 'object') {
    if (patch.hideChatRail != null) out.hideChatRail = !!patch.hideChatRail;
    if (patch.hideBottomBar != null) out.hideBottomBar = !!patch.hideBottomBar;
    if (patch.hideTopBar != null) out.hideTopBar = !!patch.hideTopBar;
    if (patch.enabled != null) out.enabled = !!patch.enabled;
    if (Array.isArray(patch.regions)) out.regions = patch.regions.slice();
  }
  return out;
}

module.exports = {
  TWITCH_UI_PRESETS,
  resolveSourceCleanupRegions,
  regionsToDelogoFilter,
  applySourceCleanup,
  sourceCleanupSummary,
  mergeSourceCleanup,
};
