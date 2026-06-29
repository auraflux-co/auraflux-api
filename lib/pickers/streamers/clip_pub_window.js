'use strict';

/** Non-overlapping publish bands for Clip Library (matches operator mental model). */
const PUB_BANDS = {
  '24h': { minHours: 0, maxHours: 24, label: '0–24h' },
  '7d': { minHours: 24, maxHours: 168, label: '24h–7d' },
  '30d': { minHours: 168, maxHours: 720, label: '7d–30d' },
  all: { minHours: 720, maxHours: null, label: '30d+' },
  any: { minHours: 0, maxHours: null, label: 'all time' },
};

const ALL_BAND_LOOKBACK_HOURS = 8760; // 365d — Helix requires started_at

function resolveClipPubWindow({ pubWindow, pubHours, pubHoursMin, pubHoursMax } = {}) {
  let minHours = pubHoursMin;
  let maxHours = pubHoursMax;
  let label = null;

  if (pubWindow && PUB_BANDS[pubWindow]) {
    ({ minHours, maxHours, label } = PUB_BANDS[pubWindow]);
  } else if (Number.isFinite(pubHours) && pubHours > 0 && minHours == null && maxHours == null) {
    // Legacy cumulative: last N hours
    minHours = 0;
    maxHours = pubHours;
    label = `${pubHours}h`;
  } else if (minHours == null) {
    minHours = 0;
  }

  const now = Date.now();
  const minMs = Math.max(0, Number(minHours) || 0) * 3600000;
  const maxMs = maxHours != null ? Number(maxHours) * 3600000 : null;

  let startedAt;
  let endedAt;
  if (maxMs != null) {
    startedAt = new Date(now - maxMs).toISOString();
  } else {
    startedAt = new Date(now - ALL_BAND_LOOKBACK_HOURS * 3600000).toISOString();
  }
  if (minMs > 0) {
    endedAt = new Date(now - minMs).toISOString();
  } else {
    endedAt = new Date(now).toISOString();
  }

  return {
    pubWindow: pubWindow || null,
    minHours: Number(minHours) || 0,
    maxHours: maxHours != null ? Number(maxHours) : null,
    label: label || (PUB_BANDS[pubWindow]?.label ?? 'custom'),
    startedAt,
    endedAt,
    minAgeMs: minMs,
    maxAgeMs: maxMs,
  };
}

function clipCreatedAtMs(createdAt) {
  if (!createdAt) return NaN;
  const t = new Date(String(createdAt).length === 10 ? `${createdAt}T12:00:00Z` : createdAt).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/** True when clip age falls in [minHours, maxHours) band. maxHours null = no upper bound. */
function clipInPubBand(createdAt, { minHours = 0, maxHours } = {}) {
  const t = clipCreatedAtMs(createdAt);
  if (!Number.isFinite(t)) return true;
  const ageMs = Date.now() - t;
  const minMs = Math.max(0, Number(minHours) || 0) * 3600000;
  const maxMs = maxHours != null ? Number(maxHours) * 3600000 : Infinity;
  return ageMs >= minMs && ageMs < maxMs;
}

module.exports = {
  PUB_BANDS,
  resolveClipPubWindow,
  clipInPubBand,
  clipCreatedAtMs,
};
