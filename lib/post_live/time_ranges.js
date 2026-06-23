'use strict';

/**
 * Parse MM:SS, HH:MM:SS, or raw seconds → float seconds.
 */
function timeToSec(t) {
  const raw = String(t || '').trim();
  if (!raw) throw new Error('Empty timestamp');
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const parts = raw.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) throw new Error(`Invalid timestamp: "${t}"`);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error(`Unexpected timestamp format: "${t}"`);
}

/**
 * Parse "12:34-13:10" or separate start/end columns.
 */
function parseRangePair(startStr, endStr) {
  if (endStr != null && String(endStr).trim()) {
    return { start: timeToSec(startStr), end: timeToSec(endStr) };
  }
  const combined = String(startStr || '').trim();
  const dash = combined.match(/^(.+?)\s*-\s*(.+)$/);
  if (!dash) throw new Error(`Invalid range: "${combined}"`);
  return { start: timeToSec(dash[1]), end: timeToSec(dash[2]) };
}

function secToHms(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function normalizeAction(raw) {
  const a = String(raw || 'exclude').trim().toLowerCase();
  if (a === 'mute' || a === 'm') return 'mute';
  if (a === 'exclude' || a === 'skip' || a === 'x' || a === 'e') return 'exclude';
  return 'exclude';
}

function mergeRanges(ranges) {
  const sorted = [...ranges]
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
      if (r.notes && !last.notes) last.notes = r.notes;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** Seconds of [windowStart, windowEnd] not covered by exclude ranges. */
function analyzableWindows(windowStart, windowEnd, excludeRanges) {
  let cursor = windowStart;
  const windows = [];
  const excludes = mergeRanges(excludeRanges);
  for (const ex of excludes) {
    if (ex.end <= cursor) continue;
    if (ex.start >= windowEnd) break;
    if (ex.start > cursor) windows.push({ start: cursor, end: Math.min(ex.start, windowEnd) });
    cursor = Math.max(cursor, ex.end);
    if (cursor >= windowEnd) break;
  }
  if (cursor < windowEnd) windows.push({ start: cursor, end: windowEnd });
  return windows.filter((w) => w.end - w.start >= 15);
}

/** Map VOD-absolute mute ranges into seconds relative to an extracted clip window. */
function mapMuteRangesToClip(muteRanges, clipStart, clipEnd) {
  const start = Number(clipStart) || 0;
  const end = Number(clipEnd) || start + 60;
  return mergeRanges((muteRanges || []).map((r) => ({
    start: r.start,
    end: r.end,
    action: r.action || 'mute',
    notes: r.notes || '',
  })))
    .filter((r) => r.start < end && r.end > start)
    .map((r) => ({
      start: Math.max(0, r.start - start),
      end: Math.min(end - start, r.end - start),
      notes: r.notes,
    }))
    .filter((r) => r.end > r.start + 0.05);
}

module.exports = {
  timeToSec,
  parseRangePair,
  secToHms,
  normalizeAction,
  mergeRanges,
  overlaps,
  analyzableWindows,
  mapMuteRangesToClip,
};
