'use strict';

/**
 * CPD-1285 / CPD-416 follow-through — kinetic drawtext overlays for assembly.
 * Styles: fade, fly_left, fly_right, scale_pop, shake.
 */

function _esc(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '%%');
}

function normalizeOverlayTexts(cfg, { windowSec } = {}) {
  if (!cfg) return [];
  const enabled = cfg.enabled !== false;
  if (!enabled && !Array.isArray(cfg)) return [];
  const raw = Array.isArray(cfg.items) ? cfg.items
    : (Array.isArray(cfg) ? cfg : (cfg.text ? [cfg] : []));
  const win = Number(windowSec) > 0 ? Number(windowSec) : 30;
  return raw.map((item, i) => {
    const text = String(item?.text || '').trim();
    if (!text) return null;
    let startSec = Number(item.startSec ?? item.atSec ?? 0);
    // C10 reaction_short preset stores ratio 0–1 of trim window
    if (item.ratio != null && Number.isFinite(Number(item.ratio))) {
      startSec = Math.max(0, Number(item.ratio) * win);
    }
    const duration = Math.max(0.4, Math.min(8, Number(item.duration) || 2.2));
    if (!Number.isFinite(startSec) || startSec < 0) return null;
    return {
      text,
      startSec,
      endSec: startSec + duration,
      style: String(item.style || cfg.style || 'fade').toLowerCase(),
      fontSize: Number(item.fontSize) || Number(cfg.fontSize) || 64,
      fontColor: item.fontColor || cfg.fontColor || 'white',
      y: item.y || cfg.y || '(h-text_h)/2',
      index: i,
    };
  }).filter(Boolean);
}

/**
 * Build chained drawtext filters for one overlay item.
 */
function buildOverlayDrawtext(item) {
  const text = _esc(item.text);
  if (!text) return null;
  const s = Number(item.startSec).toFixed(2);
  const e = Number(item.endSec).toFixed(2);
  const fs = Math.max(24, Math.min(120, Number(item.fontSize) || 64));
  const fc = item.fontColor || 'white';
  const y = item.y || '(h-text_h)/2';
  const style = String(item.style || 'fade').toLowerCase();
  const enable = `enable='between(t\\,${s}\\,${e})'`;
  const box = 'box=1:boxcolor=black@0.55:boxborderw=12';

  if (style === 'fly_left' || style === 'fly-in-left') {
    return (
      `drawtext=text='${text}':fontsize=${fs}:fontcolor=${fc}:` +
      `x='if(lt(t\\,${s}+0.35)\\,-tw+(w+tw)*((t-${s})/0.35)\\,(w-tw)/2)':y=${y}:` +
      `${box}:${enable}`
    );
  }
  if (style === 'fly_right' || style === 'fly-in-right') {
    return (
      `drawtext=text='${text}':fontsize=${fs}:fontcolor=${fc}:` +
      `x='if(lt(t\\,${s}+0.35)\\,w-(w+tw)*((t-${s})/0.35)\\,(w-tw)/2)':y=${y}:` +
      `${box}:${enable}`
    );
  }
  if (style === 'scale_pop' || style === 'pop' || style === 'scale') {
    return (
      `drawtext=text='${text}':` +
      `fontsize='if(lt(t\\,${s}+0.25)\\,${Math.round(fs * 0.55)}+${Math.round(fs * 0.45)}*((t-${s})/0.25)\\,${fs})':` +
      `fontcolor=${fc}:x=(w-text_w)/2:y=${y}:${box}:${enable}`
    );
  }
  if (style === 'shake') {
    return (
      `drawtext=text='${text}':fontsize=${fs}:fontcolor=${fc}:` +
      `x='(w-text_w)/2+8*sin(40*t)':y='(h-text_h)/2+6*cos(35*t)':` +
      `${box}:${enable}`
    );
  }
  // fade / default — timed enable (alpha expressions vary by ffmpeg build)
  return (
    `drawtext=text='${text}':fontsize=${fs}:fontcolor=${fc}:` +
    `x=(w-text_w)/2:y=${y}:${box}:${enable}`
  );
}

function buildAnimatedTextFilter(cfg, opts = {}) {
  const items = normalizeOverlayTexts(cfg, opts);
  if (!items.length) return null;
  const filters = items.map(buildOverlayDrawtext).filter(Boolean);
  return filters.length ? filters.join(',') : null;
}

module.exports = {
  normalizeOverlayTexts,
  buildOverlayDrawtext,
  buildAnimatedTextFilter,
};
