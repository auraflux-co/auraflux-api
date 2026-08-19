'use strict';

/**
 * Temporal layout segments within one source clip (Compose Phase B).
 * Breakpoints are absolute seconds on the source clip timeline; assembly maps
 * them into the trimmed window via trimStart.
 */

const LAYOUT_MODES = new Set(['split_screen', 'full_bleed_crop', 'blur_pad']);

function normalizeMode(mode, fallback = 'full_bleed_crop') {
  const m = String(mode || '').trim();
  return LAYOUT_MODES.has(m) ? m : fallback;
}

/** @typedef {{ atSec: number, mode: string, cropCx?: number, cropCy?: number, facecamRect?: object, bottomPaneRect?: object, contentCx?: number, topHeight?: number, bottomPaneMode?: string }} LayoutBreakpoint */

/**
 * Snapshot opening layout from compCreative + optional overrides.
 */
function snapshotOpeningLayout(compCreative = {}, overrides = {}) {
  const layout = compCreative.layout || {};
  const landscapeSplit = layout.landscapeSplit !== false;
  const defaultMode = landscapeSplit ? 'split_screen' : (layout.mode || 'full_bleed_crop');
  return {
    mode: normalizeMode(overrides.mode || defaultMode, defaultMode),
    cropCx: overrides.cropCx != null ? overrides.cropCx : layout.cropCx,
    cropCy: overrides.cropCy != null ? overrides.cropCy : layout.cropCy,
    cropZoom: overrides.cropZoom != null ? overrides.cropZoom : layout.cropZoom,
    facecamRect: overrides.facecamRect || layout.facecamRect || null,
    bottomPaneRect: overrides.bottomPaneRect || layout.bottomPaneRect || null,
    contentCx: overrides.contentCx != null ? overrides.contentCx : layout.contentCx,
    topHeight: overrides.topHeight != null ? overrides.topHeight : layout.topHeight,
    bottomPaneMode: overrides.bottomPaneMode || layout.bottomPaneMode || null,
  };
}

/**
 * Normalize breakpoints stored on a clip for validate/assembly.
 * @param {Array} raw
 * @param {{ trimStart?: number, trimEnd?: number }} window
 */
function normalizeLayoutBreakpoints(raw, { trimStart = 0, trimEnd } = {}) {
  const start = Math.max(0, Number(trimStart) || 0);
  const end = trimEnd != null ? Number(trimEnd) : start + 60;
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    const atSec = Math.floor(Number(row?.atSec ?? row?.at_sec));
    if (!Number.isFinite(atSec)) continue;
    if (atSec <= start || atSec >= end) continue;
    const key = String(atSec);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      atSec,
      mode: normalizeMode(row.mode),
      cropCx: row.cropCx != null ? Number(row.cropCx) : undefined,
      cropCy: row.cropCy != null ? Number(row.cropCy) : undefined,
      cropZoom: row.cropZoom != null ? Number(row.cropZoom) : undefined,
      facecamRect: row.facecamRect || null,
      bottomPaneRect: row.bottomPaneRect || null,
      contentCx: row.contentCx != null ? Number(row.contentCx) : undefined,
      topHeight: row.topHeight != null ? Number(row.topHeight) : undefined,
      bottomPaneMode: row.bottomPaneMode || null,
    });
  }
  out.sort((a, b) => a.atSec - b.atSec);
  return out;
}

/**
 * Build contiguous time ranges within [trimStart, trimEnd) each with a layout mode.
 * @returns {Array<{ startSec: number, endSec: number, mode: string, layout: object }>}
 */
function buildLayoutTimePlan({
  trimStart = 0,
  trimEnd,
  layoutSegments = [],
  openingLayout = null,
  compCreative = null,
} = {}) {
  const start = Math.max(0, Number(trimStart) || 0);
  const end = trimEnd != null ? Number(trimEnd) : start + 60;
  if (end <= start) return [];

  const opening = openingLayout || snapshotOpeningLayout(compCreative || {});
  const breakpoints = normalizeLayoutBreakpoints(layoutSegments, { trimStart: start, trimEnd: end });

  if (!breakpoints.length) {
    return [{
      startSec: start,
      endSec: end,
      mode: opening.mode,
      layout: { ...opening },
    }];
  }

  const ranges = [];
  let cursor = start;
  let active = { ...opening };

  for (const bp of breakpoints) {
    if (bp.atSec > cursor) {
      ranges.push({
        startSec: cursor,
        endSec: bp.atSec,
        mode: active.mode,
        layout: { ...active },
      });
    }
    active = {
      mode: bp.mode,
      cropCx: bp.cropCx != null ? bp.cropCx : active.cropCx,
      cropCy: bp.cropCy != null ? bp.cropCy : active.cropCy,
      cropZoom: bp.cropZoom != null ? bp.cropZoom : active.cropZoom,
      facecamRect: bp.facecamRect || active.facecamRect,
      bottomPaneRect: bp.bottomPaneRect || active.bottomPaneRect,
      contentCx: bp.contentCx != null ? bp.contentCx : active.contentCx,
      topHeight: bp.topHeight != null ? bp.topHeight : active.topHeight,
      bottomPaneMode: bp.bottomPaneMode || active.bottomPaneMode,
    };
    cursor = bp.atSec;
  }
  if (cursor < end) {
    ranges.push({
      startSec: cursor,
      endSec: end,
      mode: active.mode,
      layout: { ...active },
    });
  }
  return ranges.filter((r) => r.endSec > r.startSec);
}

function mergeCreativeForSegment(baseCreative, segmentLayout) {
  const base = baseCreative && typeof baseCreative === 'object' ? baseCreative : {};
  const layout = { ...(base.layout || {}) };
  const seg = segmentLayout || {};
  layout.mode = seg.mode;
  layout.landscapeSplit = seg.mode === 'split_screen';
  // CPD-1257: segment mode owns logo placement for per-range creative merges.
  if (seg.mode === 'full_bleed_crop' || seg.mode === 'split_screen') {
    layout.logo = 'corner';
    layout.logoCorner = 'top_right';
  } else if (seg.mode === 'blur_pad') {
    layout.logo = 'top_blur_fold';
  }
  if (seg.cropCx != null) layout.cropCx = seg.cropCx;
  if (seg.cropCy != null) layout.cropCy = seg.cropCy;
  if (seg.cropZoom != null) layout.cropZoom = seg.cropZoom;
  if (seg.facecamRect) layout.facecamRect = seg.facecamRect;
  if (seg.bottomPaneRect) layout.bottomPaneRect = seg.bottomPaneRect;
  if (seg.contentCx != null) layout.contentCx = seg.contentCx;
  if (seg.topHeight != null) layout.topHeight = seg.topHeight;
  if (seg.bottomPaneMode) layout.bottomPaneMode = seg.bottomPaneMode;
  if (seg.mode === 'split_screen') {
    delete layout.cropCx;
    delete layout.cropCy;
    delete layout.cropZoom;
  }
  return { ...base, layout };
}

function formatLayoutSegmentLabel(range, trimStart = 0) {
  const rel = (sec) => {
    const n = Math.max(0, Math.round(Number(sec) - trimStart));
    const m = Math.floor(n / 60);
    const s = n % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  };
  const modeLabel = range.mode === 'split_screen' ? 'split' : (range.mode === 'full_bleed_crop' ? 'full bleed' : 'blur-pad');
  return `${rel(range.startSec)}–${rel(range.endSec)} ${modeLabel}`;
}

function formatLayoutPlanSummary(plan, trimStart = 0) {
  if (!plan || !plan.length) return '';
  if (plan.length === 1 && !plan[0].layout) {
    return formatLayoutSegmentLabel(plan[0], trimStart);
  }
  return plan.map((r) => formatLayoutSegmentLabel(r, trimStart)).join(' → ');
}

module.exports = {
  LAYOUT_MODES,
  normalizeMode,
  snapshotOpeningLayout,
  normalizeLayoutBreakpoints,
  buildLayoutTimePlan,
  mergeCreativeForSegment,
  formatLayoutSegmentLabel,
  formatLayoutPlanSummary,
};
