'use strict';

/**
 * Blur fixed UI regions on Twitch/VOD source before layout crop (chat rail, bars).
 * Runs BEFORE portrait layout so the main crop can stay wide without losing action.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ffmpegPath, ffprobePath } = require('./ffmpeg_utils');

const execFileAsync = promisify(execFile);

/** Normalised [0,1] rects on 16:9 landscape source. */
const TWITCH_UI_PRESETS = {
  chat_rail: { id: 'chat_rail', x: 0.78, y: 0, w: 0.22, h: 1 },
  bottom_bar: { id: 'bottom_bar', x: 0, y: 0.86, w: 1, h: 0.14 },
  top_bar: { id: 'top_bar', x: 0, y: 0, w: 1, h: 0.09 },
  /** Bitly-style corner promo QR (URL imports / YouTube overlays). */
  qr_bl: { id: 'qr_bl', x: 0.01, y: 0.70, w: 0.14, h: 0.28 },
  qr_br: { id: 'qr_br', x: 0.85, y: 0.70, w: 0.14, h: 0.28 },
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
  // hideCornerQr → bottom-left Bitly-style QR (URL / YouTube overlays)
  if (sc.hideCornerQr || sc.hideQrBl) pushRect(TWITCH_UI_PRESETS.qr_bl);
  if (sc.hideQrBr) pushRect(TWITCH_UI_PRESETS.qr_br);

  for (const row of Array.isArray(sc.regions) ? sc.regions : []) {
    pushRect(row);
  }

  return out;
}

/** delogo blurs a band outside x/y/w/h — regions must sit inside the frame with margin. */
const DELOGO_FRAME_MARGIN = 10;

function clampDelogoRect(iw, ih, r) {
  const margin = DELOGO_FRAME_MARGIN;
  let x = Math.round(iw * r.x);
  let y = Math.round(ih * r.y);
  let w = Math.round(iw * r.w);
  let h = Math.round(ih * r.h);

  x = Math.max(margin, Math.min(iw - margin - 2, x));
  y = Math.max(margin, Math.min(ih - margin - 2, y));
  w = Math.min(w, iw - x - margin);
  h = Math.min(h, ih - y - margin);

  const even = (n) => {
    const v = Math.max(2, Math.round(n));
    return v % 2 === 0 ? v : v - 1;
  };
  w = even(w);
  h = even(h);

  if (x + w > iw - margin) w = even(iw - x - margin);
  if (y + h > ih - margin) h = even(ih - y - margin);

  return { x, y, w, h };
}

/** Build -vf / -filter_complex for cleanup. Returns { mode:'vf'|'fc', value, mapLabel? }. */
function buildCleanupFilterGraph(regions, width, height) {
  if (!regions.length) return null;
  const iw = Math.max(2, Math.round(Number(width) || 0));
  const ih = Math.max(2, Math.round(Number(height) || 0));
  if (!iw || !ih) return null;

  // Keep full frame height — cropping top/bottom bars changes aspect (e.g. 1920x832)
  // and breaks full-bleed 9:16 math into stretch bands. Soft-blur chrome in place.
  const even = (n) => {
    const v = Math.max(0, Math.round(n));
    return v % 2 === 0 ? v : Math.max(0, v - 1);
  };
  const blurRects = regions.map((r) => {
    const c = clampDelogoRect(iw, ih, r);
    return { ...c, id: r.id };
  }).filter((r) => r.w >= 2 && r.h >= 2);
  if (!blurRects.length) return null;

  // boxblur chroma radius must be < min(cw,ch)/2; for yuv420p chroma is half size,
  // so safe radius is < min(w,h)/4. Thin top/bottom bars (~96px) cannot use 24.
  function boxblurRadius(w, h) {
    const maxSafe = Math.max(1, Math.floor(Math.min(w, h) / 4) - 1);
    return Math.max(1, Math.min(20, maxSafe));
  }

  // Single-region simple path still uses filter_complex for consistent overlay blur.
  const parts = [];
  let v = '0:v';
  blurRects.forEach((r, i) => {
    const base = `scb${i}`;
    const src = `scs${i}`;
    const blur = `scu${i}`;
    const out = `sco${i}`;
    const radius = boxblurRadius(r.w, r.h);
    const power = Math.min(8, Math.max(2, Math.round(radius / 2)));
    parts.push(`[${v}]split=2[${base}][${src}]`);
    // Strong blur + slight darken so chrome disappears without edge smear.
    parts.push(`[${src}]crop=${r.w}:${r.h}:${r.x}:${r.y},boxblur=${radius}:${power},eq=brightness=-0.15[${blur}]`);
    parts.push(`[${base}][${blur}]overlay=${r.x}:${r.y}[${out}]`);
    v = out;
  });

  if (!parts.length) return null;
  return { mode: 'fc', value: parts.join(';'), mapLabel: v };
}

/** @deprecated name kept for tests — crop/blur graph, not delogo. */
function regionsToDelogoFilter(regions, width, height) {
  const g = buildCleanupFilterGraph(regions, width, height);
  if (!g) return null;
  if (g.mode === 'vf') return g.value;
  // Expose filter_complex string for callers/tests that only check presence.
  return g.value;
}

async function probeSourceDimensions(inputPath) {
  try {
    const { stdout } = await execFileAsync(ffprobePath(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0:s=x', inputPath,
    ], { timeout: 15_000 });
    const [w, h] = String(stdout).trim().split('x').map(Number);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: w, height: h };
  } catch {
    return null;
  }
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
async function applySourceCleanup(inputPath, outputPath, {
  compCreative = null,
  sourceCleanup = null,
  log = null,
  previewFast = false,
} = {}) {
  if (!inputPath || !fs.existsSync(inputPath)) return inputPath;
  const cfg = sourceCleanup || compCreative?.sourceCleanup || null;
  const regions = resolveSourceCleanupRegions(cfg);
  if (!regions.length) {
    if (outputPath && path.resolve(outputPath) !== path.resolve(inputPath)) {
      fs.copyFileSync(inputPath, outputPath);
    }
    return inputPath;
  }

  const dims = await probeSourceDimensions(inputPath);
  if (!dims) throw new Error('Source cleanup: could not probe video dimensions');
  const graph = buildCleanupFilterGraph(regions, dims.width, dims.height);
  if (!graph) {
    if (outputPath && path.resolve(outputPath) !== path.resolve(inputPath)) {
      fs.copyFileSync(inputPath, outputPath);
    }
    return inputPath;
  }
  const dest = outputPath || `${inputPath}.clean.mp4`;
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const vEncode = previewFast
    ? ['-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-pix_fmt', 'yuv420p'];

  let args;
  if (graph.mode === 'vf') {
    args = [
      '-y', '-i', inputPath,
      '-vf', graph.value,
      ...vEncode,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      dest,
    ];
  } else {
    args = [
      '-y', '-i', inputPath,
      '-filter_complex', graph.value,
      '-map', `[${graph.mapLabel}]`,
      '-map', '0:a?',
      ...vEncode,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      dest,
    ];
  }
  await execFfmpeg(args, previewFast ? 180000 : 120000);

  if (!fs.existsSync(dest) || fs.statSync(dest).size < 500) {
    throw new Error('Source cleanup encode failed');
  }
  if (log) {
    log(`[source-cleanup] ${regions.length} region(s): ${regions.map((r) => r.id).join(', ')} (${graph.mode})`);
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
    if (patch.hideCornerQr != null) out.hideCornerQr = !!patch.hideCornerQr;
    if (patch.hideQrBl != null) out.hideQrBl = !!patch.hideQrBl;
    if (patch.hideQrBr != null) out.hideQrBr = !!patch.hideQrBr;
    if (patch.enabled != null) out.enabled = !!patch.enabled;
    if (Array.isArray(patch.regions)) out.regions = patch.regions.slice();
  }
  return out;
}

module.exports = {
  TWITCH_UI_PRESETS,
  DELOGO_FRAME_MARGIN,
  resolveSourceCleanupRegions,
  clampDelogoRect,
  regionsToDelogoFilter,
  buildCleanupFilterGraph,
  applySourceCleanup,
  sourceCleanupSummary,
  mergeSourceCleanup,
};
