'use strict';

/**
 * CPD-1283 — CapCut-style Short tint/look presets + timed impact flashes.
 * Gemini competitor bench flagged Core_fx red tints as a CWN gap
 * (`logs/competitor_visual_bench.json`). Whole-clip grade already exists
 * (crisp/vivid/cool); this adds operator-selectable looks + beat impact tint.
 */

const LOOK_PRESETS = {
  auto: {
    label: 'Auto (show grade)',
    colorGradePreset: null,
    colorbalance: null,
  },
  crisp: {
    label: 'Crisp (default Short)',
    colorGradePreset: 'crisp',
    colorbalance: null,
  },
  vivid: {
    label: 'Vivid',
    colorGradePreset: 'vivid',
    colorbalance: null,
  },
  cool: {
    label: 'Cool / blue',
    colorGradePreset: 'cool',
    colorbalance: { rs: -0.04, gs: 0.0, bs: 0.1 },
  },
  warm: {
    label: 'Warm',
    colorGradePreset: 'warm',
    colorbalance: { rs: 0.1, gs: 0.02, bs: -0.06 },
  },
  teal: {
    label: 'Teal / CapCut-ish',
    colorGradePreset: 'crisp',
    colorbalance: { rs: -0.08, gs: 0.05, bs: 0.14 },
  },
  punch: {
    label: 'Punch (warm sat)',
    colorGradePreset: 'vivid',
    colorbalance: { rs: 0.12, gs: -0.02, bs: -0.06 },
  },
  clean: {
    label: 'Clean / flat',
    colorGradePreset: 'clean',
    colorbalance: null,
  },
  // CPD-1286 CapCut-style filter catalog (eq/colorbalance — no CapCut login / .cube LUT)
  cinema: {
    label: 'Cinema (soft contrast)',
    colorGradePreset: 'crisp',
    colorbalance: { rs: 0.04, gs: 0.0, bs: -0.02, rm: 0.02, bm: -0.03 },
  },
  noir: {
    label: 'Noir (cool desat)',
    colorGradePreset: 'cool',
    colorbalance: { rs: -0.06, gs: -0.02, bs: 0.08, rm: -0.04, gm: -0.04, bm: 0.02 },
  },
  sunset: {
    label: 'Sunset',
    colorGradePreset: 'warm',
    colorbalance: { rs: 0.16, gs: 0.04, bs: -0.12 },
  },
  arctic: {
    label: 'Arctic',
    colorGradePreset: 'cool',
    colorbalance: { rs: -0.1, gs: 0.02, bs: 0.18 },
  },
  retro: {
    label: 'Retro (amber)',
    colorGradePreset: 'warm',
    colorbalance: { rs: 0.14, gs: 0.06, bs: -0.1, rm: 0.05 },
  },
  neon: {
    label: 'Neon (magenta/cyan)',
    colorGradePreset: 'vivid',
    colorbalance: { rs: 0.1, gs: -0.08, bs: 0.12 },
  },
};

function resolveLookPreset(name) {
  const key = String(name || 'auto').trim().toLowerCase();
  return LOOK_PRESETS[key] || LOOK_PRESETS.auto;
}

function buildColorbalanceFrag(cb) {
  if (!cb || typeof cb !== 'object') return null;
  const parts = [];
  for (const k of ['rs', 'gs', 'bs', 'rm', 'gm', 'bm', 'rh', 'gh', 'bh']) {
    if (cb[k] != null && Number.isFinite(Number(cb[k]))) {
      parts.push(`${k}=${Number(cb[k]).toFixed(3)}`);
    }
  }
  return parts.length ? `colorbalance=${parts.join(':')}` : null;
}

/**
 * Timed red/impact tint windows (Gemini Core_fx pattern).
 * @param {Array<{atSec:number,duration?:number,strength?:number}>} flashes
 */
function buildImpactTintFilter(flashes) {
  const list = (Array.isArray(flashes) ? flashes : [])
    .map((f) => {
      const atSec = Number(f?.atSec ?? f?.t);
      if (!Number.isFinite(atSec) || atSec < 0) return null;
      return {
        atSec,
        duration: Math.max(0.08, Math.min(1.5, Number(f.duration) || 0.7)),
        strength: Math.max(0.08, Math.min(0.55, Number(f.strength) || 0.35)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.atSec - b.atSec);
  if (!list.length) return null;

  // Chain colorbalance filters each with enable=between(t,...)
  return list.map((f) => {
    const t0 = f.atSec.toFixed(3);
    const t1 = (f.atSec + f.duration).toFixed(3);
    const rs = f.strength.toFixed(3);
    const gs = (-f.strength * 0.35).toFixed(3);
    const bs = (-f.strength * 0.45).toFixed(3);
    return `colorbalance=rs=${rs}:gs=${gs}:bs=${bs}:enable='between(t\\,${t0}\\,${t1})'`;
  }).join(',');
}

function normalizeImpactTints(cfg) {
  if (!cfg || cfg.enabled === false) return [];
  const raw = Array.isArray(cfg.flashes) ? cfg.flashes
    : (Array.isArray(cfg) ? cfg : (cfg.atSec != null ? [cfg] : []));
  return raw.map((f) => {
    const atSec = Number(f?.atSec ?? f?.t);
    if (!Number.isFinite(atSec)) return null;
    return {
      atSec,
      duration: Number(f.duration) || 0.28,
      strength: Number(f.strength) || 0.22,
    };
  }).filter(Boolean);
}

/**
 * Merge look preset into clip-comp effects jobSpec fragment.
 */
function applyLookToEffectsSpec(spec, lookName) {
  const base = spec && typeof spec === 'object' ? { ...spec } : {};
  const look = resolveLookPreset(lookName);
  if (look.colorGradePreset) {
    base.colorGrade = { ...(base.colorGrade || {}), preset: look.colorGradePreset };
  }
  base.effects = base.effects || {};
  base.effects.color = { ...(base.effects.color || {}) };
  if (look.colorbalance) {
    base.effects.color.colorBalance = look.colorbalance;
  }
  base.lookPreset = String(lookName || 'auto');
  return base;
}

/** Speed feel presets → clip.speedRamps (CPD-1281 UI). */
const SPEED_FEELS = {
  normal: { label: 'Normal speed', ramps: null },
  slowmo_hit: {
    label: 'Slow-mo hit (mid 1s @ 0.55×)',
    ramps: [{ startSec: 0.8, endSec: 1.8, factor: 0.55 }],
  },
  ramp_in: {
    label: 'Ramp in (0.7× → 1.25×)',
    ramps: [
      { startSec: 0, endSec: 1.2, factor: 0.7 },
      { startSec: 1.2, endSec: 2.4, factor: 1.25 },
    ],
  },
  punch_pause: {
    label: 'Punch pause (0.4s @ 0.4×)',
    ramps: [{ startSec: 1.0, endSec: 1.4, factor: 0.4 }],
  },
};

function resolveSpeedFeel(name, { trimStart = 0, trimEnd = 30 } = {}) {
  const key = String(name || 'normal').trim().toLowerCase();
  const feel = SPEED_FEELS[key] || SPEED_FEELS.normal;
  if (!feel.ramps) return null;
  const window = Math.max(4, (Number(trimEnd) || 30) - (Number(trimStart) || 0));
  // Scale template times into the Short trim window (templates authored for ~0–3s).
  const scale = Math.min(2.5, Math.max(0.8, window / 12));
  return feel.ramps.map((r) => ({
    startSec: (Number(trimStart) || 0) + r.startSec * scale,
    endSec: (Number(trimStart) || 0) + r.endSec * scale,
    factor: r.factor,
  }));
}

module.exports = {
  LOOK_PRESETS,
  SPEED_FEELS,
  resolveLookPreset,
  buildColorbalanceFrag,
  buildImpactTintFilter,
  normalizeImpactTints,
  applyLookToEffectsSpec,
  resolveSpeedFeel,
};
