'use strict';
/**
 * Publish-window bands for Peaks VOD discovery (adapted from C0 clip_pub_window).
 * Same operator mental model: last24h / last7d / last30d / 7d / 30d / all / any.
 */

const PUB_BANDS = {
  last24h: { minHours: 0, maxHours: 24, label: 'last 24h' },
  last7d: { minHours: 0, maxHours: 168, label: 'last 7d' },
  last30d: { minHours: 0, maxHours: 720, label: 'last 30d' },
  '24h': { minHours: 0, maxHours: 24, label: '0–24h' },
  '7d': { minHours: 24, maxHours: 168, label: '24h–7d' },
  '30d': { minHours: 168, maxHours: 720, label: '7d–30d' },
  all: { minHours: 720, maxHours: null, label: '30d+' },
  any: { minHours: 0, maxHours: null, label: 'all time' },
};

/** Helix-style lookback when band has no upper bound (any / open-ended). */
const ALL_BAND_LOOKBACK_HOURS = 8760; // 365d

const DEFAULT_WINDOW = 'last7d';
const MAX_VOD_LIMIT = 200;

function resolvePubWindow(pubWindow) {
  const key = PUB_BANDS[pubWindow] ? pubWindow : DEFAULT_WINDOW;
  const { minHours, maxHours, label } = PUB_BANDS[key];
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
    pubWindow: key,
    minHours: Number(minHours) || 0,
    maxHours: maxHours != null ? Number(maxHours) : null,
    label,
    startedAt,
    endedAt,
    minAgeMs: minMs,
    maxAgeMs: maxMs,
    /** ISO cutoff for newest-first playlist early-stop (null when open-ended older band). */
    publishedAfter: maxMs != null ? startedAt : null,
  };
}

function createdAtMs(createdAt) {
  if (!createdAt) return NaN;
  const raw = String(createdAt);
  const t = new Date(raw.length === 10 ? `${raw}T12:00:00Z` : raw).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/** True when age falls in [minHours, maxHours). maxHours null = no upper bound. */
function inPubBand(createdAt, { minHours = 0, maxHours } = {}) {
  const t = createdAtMs(createdAt);
  if (!Number.isFinite(t)) return true;
  const ageMs = Date.now() - t;
  const minMs = Math.max(0, Number(minHours) || 0) * 3600000;
  const maxMs = maxHours != null ? Number(maxHours) * 3600000 : Infinity;
  return ageMs >= minMs && ageMs < maxMs;
}

function filterVodsByPubWindow(vods, pubBand) {
  if (!pubBand) return vods || [];
  return (vods || []).filter((v) => inPubBand(v.createdAt || v.publishedAt, pubBand));
}

function filterVodsByDuration(vods, { minDurationSec = 0, maxDurationSec = null } = {}) {
  const min = Math.max(0, Number(minDurationSec) || 0);
  const max = maxDurationSec != null && maxDurationSec !== ''
    ? Number(maxDurationSec)
    : null;
  return (vods || []).filter((v) => {
    const d = Number(v.duration) || 0;
    if (d < min) return false;
    if (max != null && Number.isFinite(max) && d > max) return false;
    return true;
  });
}

function sortVods(vods, sort = 'recent') {
  const list = [...(vods || [])];
  if (sort === 'popular') {
    list.sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0));
  } else {
    list.sort((a, b) => {
      const tb = createdAtMs(b.createdAt || b.publishedAt) || 0;
      const ta = createdAtMs(a.createdAt || a.publishedAt) || 0;
      return tb - ta;
    });
  }
  return list;
}

function parseVodListQuery(query = {}) {
  const windowKey = String(query.window || DEFAULT_WINDOW).toLowerCase();
  const band = resolvePubWindow(PUB_BANDS[windowKey] ? windowKey : DEFAULT_WINDOW);
  const minDurationSec = Math.max(
    0,
    parseInt(query.minDurationSec != null ? query.minDurationSec : '180', 10) || 180,
  );
  const maxRaw = query.maxDurationSec;
  const maxDurationSec = maxRaw != null && String(maxRaw).trim() !== ''
    ? Math.max(0, parseInt(maxRaw, 10) || 0)
    : null;
  const sort = String(query.sort || 'recent').toLowerCase() === 'popular' ? 'popular' : 'recent';
  const wantLimit = Math.min(
    Math.max(1, parseInt(query.limit, 10) || 40),
    MAX_VOD_LIMIT,
  );
  return { band, minDurationSec, maxDurationSec, sort, limit: wantLimit };
}

function applyVodDiscoveryFilters(vods, { band, minDurationSec, maxDurationSec, sort, limit }) {
  let out = filterVodsByPubWindow(vods, band);
  out = filterVodsByDuration(out, { minDurationSec, maxDurationSec });
  out = sortVods(out, sort);
  return out.slice(0, limit);
}

module.exports = {
  PUB_BANDS,
  DEFAULT_WINDOW,
  MAX_VOD_LIMIT,
  ALL_BAND_LOOKBACK_HOURS,
  resolvePubWindow,
  createdAtMs,
  inPubBand,
  filterVodsByPubWindow,
  filterVodsByDuration,
  sortVods,
  parseVodListQuery,
  applyVodDiscoveryFilters,
};
