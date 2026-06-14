/**
 * Sports highlight picker — multi-provider, multi-category, 48h-active gate.
 */
const espn = require('./adapters/espn');
const bbcSport = require('./adapters/bbc_sport');
const {
  getEspnLeagues,
  getEspnLeaguesAsync,
  resolveEspnCategoryId,
  getBbcCategories,
  getProbeWindowHours,
  discovery,
} = require('./config');

const _categoryCache = { ts: 0, data: null, pubHours: null };

function applyClipFilters(videos, { durMin, durMax, pubHours } = {}) {
  const pubSinceMs = pubHours != null && Number(pubHours) > 0
    ? Date.now() - Number(pubHours) * 3600000
    : null;

  return videos.filter(v => {
    const dur = Number(v.duration);
    if (durMin != null && (!Number.isFinite(dur) || dur < durMin)) return false;
    if (durMax != null && (!Number.isFinite(dur) || dur > durMax)) return false;
    if (pubSinceMs != null) {
      const t = new Date(v.publishedAt || 0).getTime();
      if (!Number.isFinite(t) || t < pubSinceMs) return false;
    }
    return true;
  });
}

function sortSportsClips(videos, targetSec = 30) {
  return [...videos].sort((a, b) => {
    const da = Number(a.duration);
    const db = Number(b.duration);
    const ta = Number.isFinite(da) ? Math.abs(da - targetSec) : 9999;
    const tb = Number.isFinite(db) ? Math.abs(db - targetSec) : 9999;
    if (ta !== tb) return ta - tb;
    return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
  });
}

async function mapPool(items, concurrency, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(fn));
    out.push(...results);
  }
  return out;
}

function normalizeCategoryIds(rawIds) {
  const espnLeagues = getEspnLeagues();
  const bbcCats = getBbcCategories();
  const out = [];
  for (const raw of rawIds || []) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) continue;
    const espnId = resolveEspnCategoryId(key);
    if (espnId && espnLeagues[espnId]) {
      if (!out.includes(espnId)) out.push(espnId);
      continue;
    }
    if (bbcCats[key] && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Probe all ESPN leagues (from discovery) + BBC; return only 48h-active.
 */
async function probeActiveCategories(opts = {}) {
  const pubHours = opts.pubHours != null ? opts.pubHours : getProbeWindowHours();
  const cacheMs = (opts.cacheMs != null ? opts.cacheMs : 20) * 60 * 1000;
  if (
    _categoryCache.data
    && _categoryCache.pubHours === pubHours
    && Date.now() - _categoryCache.ts < cacheMs
    && !opts.forceDiscovery
  ) {
    return _categoryCache.data;
  }

  if (opts.forceDiscovery) {
    discovery.clearDiscoveryCache();
    clearCategoryCache();
  }

  await getEspnLeaguesAsync(opts.forceDiscovery);
  const espnLeagues = getEspnLeagues();
  const espnKeys = Object.keys(espnLeagues);
  const bbcKeys = Object.keys(getBbcCategories());
  const extractVideo = opts.extractBbcVideo;

  const [espnResults, bbcResults] = await Promise.all([
    mapPool(espnKeys, 12, key => espn.probeLeagueRecentVideo(key, pubHours)),
    extractVideo
      ? mapPool(bbcKeys, 4, key => bbcSport.probeCategoryRecentVideo(key, pubHours, extractVideo))
      : Promise.resolve(bbcKeys.map(key => ({ active: false, provider: 'bbc', id: key }))),
  ]);

  const active = [...espnResults, ...bbcResults].filter(r => r.active);
  const reg = discovery.getEspnRegistrySync();
  const payload = {
    pubHours,
    probedAt: new Date().toISOString(),
    espnLeagueCount: espnKeys.length,
    espnDiscoveredAt: reg.discoveredAt,
    categories: active,
    espn: active.filter(c => c.provider === 'espn'),
    bbc: active.filter(c => c.provider === 'bbc'),
  };

  _categoryCache.ts = Date.now();
  _categoryCache.pubHours = pubHours;
  _categoryCache.data = payload;
  return payload;
}

async function fetchSportsHighlights(opts = {}) {
  await getEspnLeaguesAsync(false);
  const limit = Math.min(parseInt(opts.limit || '30', 10) || 30, 50);
  const pubHours = opts.pubHours != null ? opts.pubHours : getProbeWindowHours();
  const espnLeagues = getEspnLeagues();
  const bbcCats = getBbcCategories();

  let categoryIds = opts.categories;
  if (!categoryIds || !categoryIds.length) {
    const src = (opts.source || 'nba').toLowerCase();
    if (src === 'bbc_sport' || bbcCats[src]) {
      categoryIds = [src === 'bbc_sport' ? 'football' : src];
    } else {
      categoryIds = [resolveEspnCategoryId(src) || src];
    }
  }
  categoryIds = normalizeCategoryIds(categoryIds);

  const perCatLimit = Math.ceil((limit * 2) / Math.max(1, categoryIds.length || 1));
  let videos = [];

  await mapPool(categoryIds, 4, async catId => {
    if (espnLeagues[catId]) {
      const clips = await espn.fetchLeagueHighlights({
        league: catId,
        limit: perCatLimit,
        dateYmd: opts.date || null,
      });
      videos.push(...clips);
    } else if (bbcCats[catId] && opts.extractBbcVideo) {
      const clips = await bbcSport.fetchCategoryHighlights({
        categoryKey: catId,
        limit: perCatLimit,
        pubHours,
        extractVideo: opts.extractBbcVideo,
      });
      videos.push(...clips);
    }
  });

  videos = applyClipFilters(videos, { ...opts, pubHours: opts.pubHours != null ? opts.pubHours : pubHours });
  videos = sortSportsClips(videos, opts.targetSec || 30);

  const seen = new Set();
  videos = videos.filter(v => {
    const key = ((v.title || '') + (v.hlsUrl || '')).toLowerCase().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return videos.slice(0, limit);
}

function listSources() {
  const reg = discovery.getEspnRegistrySync();
  const leagues = getEspnLeagues();
  return {
    espnLeagues: Object.entries(leagues).map(([id, cfg]) => ({
      id,
      label: cfg.label,
      type: 'espn',
      provider: 'espn',
      apiPath: cfg.path,
      webUrl: cfg.webUrl || '',
      webSegments: cfg.webSegments || [],
    })),
    espnDiscoveredAt: reg.discoveredAt,
    espnLeagueCount: reg.count || Object.keys(leagues).length,
    bbcCategories: Object.entries(getBbcCategories()).map(([id, cfg]) => ({
      id, label: cfg.label, type: 'bbc', provider: 'bbc',
    })),
    probeWindowHours: getProbeWindowHours(),
  };
}

function clearCategoryCache() {
  _categoryCache.ts = 0;
  _categoryCache.data = null;
  _categoryCache.pubHours = null;
}

module.exports = {
  fetchSportsHighlights,
  probeActiveCategories,
  clearCategoryCache,
  normalizeCategoryIds,
  applyClipFilters,
  sortSportsClips,
  listSources,
  espn,
  bbcSport,
  discovery,
};
