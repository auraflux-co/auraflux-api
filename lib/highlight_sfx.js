'use strict';

/**
 * CPD-1286 / CPD-417 follow-through — timed highlight SFX drops (not cut-boundary only).
 */

const path = require('path');
const fs = require('fs');

const AUDIO_DIR = path.join(__dirname, '..', 'assets', 'audio');

const SFX_FILES = {
  whoosh: 'ES_Oui (Instrumental Version) - Baha Bank$.mp3',
  impact: 'ES_BUZZER BEATER (Instrumental Version) - Demon Baby.mp3',
};

function resolveSfxPath(kind) {
  const key = String(kind || 'whoosh').toLowerCase();
  const file = SFX_FILES[key] || SFX_FILES.whoosh;
  const full = path.join(AUDIO_DIR, file);
  return fs.existsSync(full) ? full : null;
}

/**
 * Normalize drop marks: [{atSec, kind?}]
 */
function normalizeHighlightDrops(cfg) {
  if (!cfg || cfg.enabled === false) return [];
  const raw = Array.isArray(cfg.drops) ? cfg.drops
    : (Array.isArray(cfg) ? cfg : (cfg.atSec != null ? [cfg] : []));
  return raw.map((d, i) => {
    const atSec = Number(d?.atSec ?? d?.t);
    if (!Number.isFinite(atSec) || atSec < 0) return null;
    return {
      atSec,
      kind: String(d.kind || (i % 2 === 0 ? 'whoosh' : 'impact')).toLowerCase(),
      // Cap peaks — Beats→FX used to ship ~0.47 and muddy bed+VO (CPD-1294)
      volume: Math.max(0.1, Math.min(0.32, Number(d.volume) || 0.28)),
    };
  }).filter(Boolean)
    .sort((a, b) => a.atSec - b.atSec);
}

/**
 * Build suggestions from beat peaks → highlight SFX drops.
 */
function sfxDropsFromPeaks(peaks) {
  const list = Array.isArray(peaks) ? peaks : [];
  return {
    enabled: list.length > 0,
    drops: list.map((p, i) => ({
      atSec: p.atSec,
      kind: i % 2 === 0 ? 'impact' : 'whoosh',
      volume: Math.min(0.55, 0.35 + (p.score || 1) * 0.05),
    })),
  };
}

module.exports = {
  SFX_FILES,
  resolveSfxPath,
  normalizeHighlightDrops,
  sfxDropsFromPeaks,
};
