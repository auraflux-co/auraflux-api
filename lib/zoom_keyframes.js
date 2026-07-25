'use strict';

/**
 * CPD-1279 — FFmpeg zoom keyframes for Compose layoutSegments + zoom_punch.
 * CapCut is export-only; zoom burns in during portrait layout / effects pass.
 */

function clampZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.25, Math.min(4, n));
}

function clamp01(n, fallback = 0.5) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function layoutZoomSig(layout = {}) {
  return {
    cropZoom: clampZoom(layout.cropZoom != null ? layout.cropZoom : 1),
    cropCx: clamp01(layout.cropCx, 0.5),
    cropCy: clamp01(layout.cropCy, 0.5),
  };
}

function zoomLooksDiffer(a, b, eps = 0.02) {
  return (
    Math.abs(a.cropZoom - b.cropZoom) > eps
    || Math.abs(a.cropCx - b.cropCx) > eps
    || Math.abs(a.cropCy - b.cropCy) > eps
  );
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOut(t) {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

/**
 * When consecutive full_bleed ranges only change crop zoom/centre, insert
 * short interpolated micro-segments so EXECUTE ramps instead of hard-cutting.
 *
 * @param {Array<{startSec:number,endSec:number,mode:string,layout:object}>} plan
 * @param {{ rampSec?: number, stepSec?: number }} [opts]
 */
function expandZoomRamps(plan, { rampSec = 0.4, stepSec = 0.08 } = {}) {
  if (!Array.isArray(plan) || plan.length < 2) return plan || [];
  const ramp = Math.max(0.12, Math.min(1.2, Number(rampSec) || 0.4));
  const step = Math.max(0.04, Math.min(0.25, Number(stepSec) || 0.08));
  const out = [];

  for (let i = 0; i < plan.length; i++) {
    const cur = plan[i];
    const prev = plan[i - 1];
    const sameFullBleed = cur?.mode === 'full_bleed_crop'
      && prev?.mode === 'full_bleed_crop';
    const from = prev ? layoutZoomSig(prev.layout) : null;
    const to = layoutZoomSig(cur.layout);

    if (!sameFullBleed || !from || !zoomLooksDiffer(from, to)) {
      out.push({ ...cur, layout: { ...(cur.layout || {}) } });
      continue;
    }

    const windowDur = Math.max(0, Number(cur.endSec) - Number(cur.startSec));
    const useRamp = Math.min(ramp, Math.max(0, windowDur - 0.04));
    if (useRamp < step * 1.5) {
      out.push({ ...cur, layout: { ...(cur.layout || {}) } });
      continue;
    }

    const steps = Math.max(2, Math.round(useRamp / step));
    for (let s = 1; s <= steps; s++) {
      const t0 = (s - 1) / steps;
      const t1 = s / steps;
      const mid = easeInOut((t0 + t1) / 2);
      const startSec = cur.startSec + useRamp * t0;
      const endSec = cur.startSec + useRamp * t1;
      out.push({
        startSec,
        endSec,
        mode: 'full_bleed_crop',
        layout: {
          ...(cur.layout || {}),
          mode: 'full_bleed_crop',
          cropZoom: lerp(from.cropZoom, to.cropZoom, mid),
          cropCx: lerp(from.cropCx, to.cropCx, mid),
          cropCy: lerp(from.cropCy, to.cropCy, mid),
        },
      });
    }

    if (cur.endSec > cur.startSec + useRamp + 0.02) {
      out.push({
        startSec: cur.startSec + useRamp,
        endSec: cur.endSec,
        mode: cur.mode,
        layout: { ...(cur.layout || {}) },
      });
    }
  }

  return out.filter((r) => Number(r.endSec) > Number(r.startSec) + 0.02);
}

/**
 * Normalize zoom_punch config into punch list.
 * Supports:
 *   { enabled, punches: [{ atSec, zoom, duration, cx, cy }] }
 *   { enabled, atSec, zoom, duration, cx, cy }  // single
 */
function normalizeZoomPunches(cfg) {
  if (!cfg || cfg.enabled === false) return [];
  const raw = Array.isArray(cfg.punches) && cfg.punches.length
    ? cfg.punches
    : (cfg.atSec != null || cfg.t != null
      ? [{
        atSec: cfg.atSec != null ? cfg.atSec : cfg.t,
        zoom: cfg.zoom != null ? cfg.zoom : cfg.scale,
        duration: cfg.duration,
        cx: cfg.cx,
        cy: cfg.cy,
      }]
      : []);

  return raw.map((p) => {
    const atSec = Number(p?.atSec ?? p?.t);
    if (!Number.isFinite(atSec) || atSec < 0) return null;
    return {
      atSec,
      zoom: clampZoom(p.zoom != null ? p.zoom : (p.scale != null ? p.scale : 1.28)),
      duration: Math.max(0.12, Math.min(2, Number(p.duration) || 0.4)),
      cx: clamp01(p.cx, 0.5),
      cy: clamp01(p.cy, 0.5),
    };
  }).filter(Boolean).sort((a, b) => a.atSec - b.atSec);
}

/**
 * Build zoompan z/x/y expressions for punch-ins on an already-framed clip.
 * Uses output frame index `on` at the given fps (zoompan cannot use wall-clock `t`
 * reliably across all builds).
 *
 * @returns {string|null} single -vf fragment
 */
function buildZoomPunchFilter(punches, {
  width = 1080,
  height = 1920,
  fps = 30,
} = {}) {
  const list = Array.isArray(punches) ? punches : normalizeZoomPunches(punches);
  if (!list.length) return null;

  const w = Math.max(16, Math.round(Number(width) || 1080));
  const h = Math.max(16, Math.round(Number(height) || 1920));
  const rate = Math.max(1, Math.round(Number(fps) || 30));

  // Nested if(on): before punch → hold; during → lerp; after → next punch or hold.
  function nest(i, prevZoom) {
    if (i >= list.length) return Number(prevZoom).toFixed(4);
    const p = list[i];
    const startOn = Math.round(p.atSec * rate);
    const durOn = Math.max(2, Math.round(p.duration * rate));
    const endOn = startOn + durOn;
    const z0 = Number(prevZoom);
    const z1 = p.zoom;
    const ramp = `${z0.toFixed(4)}+${(z1 - z0).toFixed(4)}*max(0\\,min(1\\,(on-${startOn})/${durOn}))`;
    const after = nest(i + 1, z1);
    return `if(lt(on\\,${startOn})\\,${z0.toFixed(4)}\\,if(lt(on\\,${endOn})\\,${ramp}\\,${after}))`;
  }
  const zExpr = nest(0, 1);

  // Subject-centred crop; bias toward the active punch centre as zoom increases.
  const cx = list[list.length - 1].cx;
  const cy = list[list.length - 1].cy;
  const xExpr = `${cx.toFixed(4)}*iw-iw/zoom/2`;
  const yExpr = `${cy.toFixed(4)}*ih-ih/zoom/2`;

  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${w}x${h}:fps=${rate},setsar=1,format=yuv420p`;
}

/**
 * Derive zoom_punch punches from a layout time plan (optional AI/export bridge).
 */
function punchesFromLayoutPlan(plan, { minZoomDelta = 0.08 } = {}) {
  if (!Array.isArray(plan) || plan.length < 2) return [];
  const punches = [];
  for (let i = 1; i < plan.length; i++) {
    const prev = layoutZoomSig(plan[i - 1].layout);
    const cur = layoutZoomSig(plan[i].layout);
    if (cur.cropZoom - prev.cropZoom < minZoomDelta) continue;
    if (plan[i].mode !== 'full_bleed_crop') continue;
    punches.push({
      atSec: Number(plan[i].startSec) || 0,
      zoom: cur.cropZoom,
      duration: 0.35,
      cx: cur.cropCx,
      cy: cur.cropCy,
    });
  }
  return punches;
}

module.exports = {
  clampZoom,
  layoutZoomSig,
  zoomLooksDiffer,
  expandZoomRamps,
  normalizeZoomPunches,
  buildZoomPunchFilter,
  punchesFromLayoutPlan,
};
