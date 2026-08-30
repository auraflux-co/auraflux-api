'use strict';

/**
 * C10 / reaction_short — burn Compose FX intent on EXECUTE when the operator
 * skipped Beats→FX / Gap fixes. Maps speedFeel → speedRamps, auto beat peaks →
 * zoom/shake/impact, and densifies look + anim text so Shorts don't look like
 * the raw source with a soft grade.
 */

const { resolveSpeedFeel } = require('./look_presets');

const AUTO_BEAT_PRESETS = new Set(['reaction_short', 'fableflow_speed']);

function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

function hasEnabledFx(cfg, listKey) {
  if (!cfg || cfg.enabled === false) return false;
  const list = cfg[listKey];
  return Array.isArray(list) && list.length > 0;
}

function expandAnimRatios(items, durationSec) {
  const dur = Math.max(4, Number(durationSec) || 30);
  return (items || []).map((it) => {
    const out = { ...it };
    if (out.startSec == null && out.ratio != null && Number.isFinite(Number(out.ratio))) {
      out.startSec = Math.round(Number(out.ratio) * dur * 100) / 100;
      delete out.ratio;
    }
    return out;
  });
}

/** Denser punch lines so text is present across most of a ~60s reaction Short. */
function densifyAnimatedText(animatedText, durationSec) {
  const dur = Math.max(8, Number(durationSec) || 30);
  const existing = expandAnimRatios(animatedText?.items || [], dur);
  const coverage = existing.reduce((a, it) => a + (Number(it.duration) || 0), 0);
  // Already dense enough (operator custom pack)
  if (existing.length >= 6 && coverage >= dur * 0.35) {
    return { enabled: true, items: existing };
  }

  const pack = [
    { text: 'WATCH THIS', ratio: 0.01, duration: 3.5, style: 'scale_pop', fontSize: 78 },
    { text: 'HERE WE GO', ratio: 0.14, duration: 2.4, style: 'scale_pop', fontSize: 76 },
    { text: 'WAIT FOR IT', ratio: 0.30, duration: 2.2, style: 'scale_pop', fontSize: 78 },
    { text: 'UNBELIEVABLE', ratio: 0.48, duration: 3.0, style: 'scale_pop', fontSize: 76 },
    { text: 'THE DROP', ratio: 0.68, duration: 3.0, style: 'scale_pop', fontSize: 78 },
    { text: 'INSANE', ratio: 0.88, duration: 2.5, style: 'scale_pop', fontSize: 76 },
  ];

  // Preserve operator-edited WAIT FOR IT wall-clock if present
  const waitOp = existing.find((it) => /WAIT FOR IT/i.test(String(it.text || '')));
  const items = expandAnimRatios(pack, dur);
  if (waitOp && waitOp.startSec != null) {
    const idx = items.findIndex((it) => /WAIT FOR IT/i.test(String(it.text || '')));
    if (idx >= 0) {
      items[idx].startSec = Number(waitOp.startSec);
      items[idx].duration = Number(waitOp.duration) > 0 ? Number(waitOp.duration) : 2.2;
    }
  }
  return { enabled: true, items };
}

function strengthenCompCreativeForExecute(compCreative, { durationSec = 30 } = {}) {
  const c = clone(compCreative) || {};
  const preset = c.preset || '';
  if (preset !== 'reaction_short' && !c.effects?.autoExecuteFx) return c;

  const lookName = c.look?.preset || 'auto';
  if (!lookName || lookName === 'auto' || lookName === 'vivid' || lookName === 'crisp') {
    c.look = { ...(c.look || {}), preset: 'punch' };
  }

  c.animatedText = densifyAnimatedText(c.animatedText, durationSec);
  c.effects = { ...(c.effects || {}), transform: true, autoExecuteFx: true };
  // Stronger film grain for reaction packaging (source stage light eats mild grain)
  // Cap grain — CRF + heavy noise ballooned one Short to ~1.5GB / 208Mbps
  c.look = {
    ...c.look,
    filmGrainStrength: Math.min(9, Math.max(7, Number(c.look?.filmGrainStrength) || 8)),
  };
  if (c.speedFeel == null || c.speedFeel === 'normal') {
    c.speedFeel = 'punch_pause';
  }
  c.beatSync = {
    ...(c.beatSync || {}),
    suggestOnPreview: true,
    autoExecute: true,
    source: (c.beatSync && c.beatSync.source) || 'clip',
    maxPeaks: Math.max(6, Number(c.beatSync?.maxPeaks) || 6),
  };
  return c;
}

function wantsAutoBeats(compCreative) {
  if (!compCreative) return false;
  if (compCreative.beatSync?.autoExecute === false) return false;
  if (compCreative.beatSync?.autoExecute === true) return true;
  return AUTO_BEAT_PRESETS.has(compCreative.preset);
}

/**
 * Fill missing speedRamps / beat FX on clip metas from creative + clip audio.
 * Mutates a clone of clipMetas; may attach highlightSfx onto returned creative.
 */
async function enrichClipMetasForExecute({
  clipFiles = [],
  clipMetas = [],
  compCreative = null,
  log = () => {},
} = {}) {
  const creative = clone(compCreative) || {};
  const metas = clipFiles.map((_, i) => clone(clipMetas[i] || {}) || {});
  const notes = [];

  for (let i = 0; i < clipFiles.length; i++) {
    const meta = metas[i];
    const filePath = clipFiles[i];
    if (!filePath) continue;

    const trimStart = Number(meta.trimStart) || 0;
    let trimEnd = meta.trimEnd != null ? Number(meta.trimEnd) : null;
    let durationSec = 30;
    try {
      const { probeDurationSec } = require('./clip_comp_tts');
      const full = await probeDurationSec(filePath);
      if (Number.isFinite(full) && full > 0) {
        durationSec = trimEnd != null && trimEnd > trimStart
          ? (trimEnd - trimStart)
          : full;
        if (trimEnd == null) trimEnd = trimStart + full;
      }
    } catch (_probe) { /* keep default */ }

    // 1) speedFeel → speedRamps
    if (!meta.speedRamps && creative.speedFeel && creative.speedFeel !== 'normal') {
      const ramps = resolveSpeedFeel(creative.speedFeel, {
        trimStart: 0, // file already trimmed to Short window in segment pass
        trimEnd: durationSec,
      });
      if (ramps && ramps.length) {
        meta.speedRamps = ramps;
        notes.push(`clip${i + 1}: speedFeel ${creative.speedFeel} → ${ramps.length} ramp(s)`);
      }
    }

    // 2) Auto Beats→FX when operator never ran Compose detect
    const missingBeats = !hasEnabledFx(meta.zoomPunch, 'punches')
      && !hasEnabledFx(meta.impactTint, 'flashes');
    if (wantsAutoBeats(creative) && missingBeats) {
      try {
        const { analyzeBeatsOnFile } = require('./beat_detect');
        const maxPeaks = Number(creative.beatSync?.maxPeaks) || 6;
        const result = await analyzeBeatsOnFile(filePath, {
          maxSec: Math.min(90, Math.max(12, durationSec + 2)),
          maxPeaks,
        });
        if (result.zoomPunch) meta.zoomPunch = result.zoomPunch;
        if (result.cameraShake) meta.cameraShake = result.cameraShake;
        if (result.impactTint) {
          meta.impactTint = result.impactTint;
          creative.look = { ...(creative.look || {}), impactTint: result.impactTint };
        }
        if (result.highlightSfx?.drops?.length) {
          meta.highlightSfx = result.highlightSfx;
          creative.audio = creative.audio || {};
          // Enable highlight drops for mix pass (preset had them disabled)
          creative.audio.highlightSfx = {
            enabled: true,
            drops: result.highlightSfx.drops,
          };
        }
        notes.push(`clip${i + 1}: auto beats ${result.peakCount || 0} peak(s)`);
      } catch (e) {
        notes.push(`clip${i + 1}: auto beats skipped — ${String(e.message || e).slice(0, 100)}`);
        log(`  ⚠️  Auto Beats→FX skipped: ${String(e.message || e).slice(0, 120)}`);
      }
    }
  }

  let durationForAnim = 30;
  try {
    const { probeDurationSec } = require('./clip_comp_tts');
    if (clipFiles[0]) {
      const d = await probeDurationSec(clipFiles[0]);
      if (Number.isFinite(d) && d > 0) durationForAnim = d;
    }
  } catch (_e) { /* default */ }

  const strengthened = strengthenCompCreativeForExecute(creative, { durationSec: durationForAnim });
  // Carry highlight SFX + impact from enrich onto strengthened creative
  if (creative.audio?.highlightSfx?.drops?.length) {
    strengthened.audio = strengthened.audio || {};
    strengthened.audio.highlightSfx = creative.audio.highlightSfx;
  }
  if (creative.look?.impactTint) {
    strengthened.look = { ...(strengthened.look || {}), impactTint: creative.look.impactTint };
  }

  if (notes.length) log(`  🎬 EXECUTE FX enrich: ${notes.join('; ')}`);

  return {
    clipMetas: metas,
    compCreative: strengthened,
    notes,
  };
}

module.exports = {
  expandAnimRatios,
  densifyAnimatedText,
  strengthenCompCreativeForExecute,
  enrichClipMetasForExecute,
  wantsAutoBeats,
  AUTO_BEAT_PRESETS,
};
