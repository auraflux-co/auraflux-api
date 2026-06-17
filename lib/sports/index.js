/**
 * Sports highlight picker — multi-provider, multi-category, 48h-active gate.
 */
const fs = require('fs');
const path = require('path');
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
const _CATEGORY_CACHE_FILE = path.join(__dirname, '..', '..', 'tmp', 'sports_category_probe.json');

function _readCategoryDiskCache(pubHours) {
  try {
    if (!fs.existsSync(_CATEGORY_CACHE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(_CATEGORY_CACHE_FILE, 'utf8'));
    if (!raw || raw.pubHours !== pubHours || !raw.categories) return null;
    const ageMs = Date.now() - new Date(raw.probedAt || 0).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 20 * 60 * 1000) return null;
    return raw;
  } catch (_e) {
    return null;
  }
}

function _writeCategoryDiskCache(payload) {
  try {
    fs.mkdirSync(path.dirname(_CATEGORY_CACHE_FILE), { recursive: true });
    fs.writeFileSync(_CATEGORY_CACHE_FILE, JSON.stringify(payload));
  } catch (_e) { /* non-fatal */ }
}

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

  if (!opts.forceDiscovery) {
    const disk = _readCategoryDiskCache(pubHours);
    if (disk) {
      _categoryCache.ts = Date.now();
      _categoryCache.pubHours = pubHours;
      _categoryCache.data = disk;
      return disk;
    }
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
  _writeCategoryDiskCache(payload);
  return payload;
}

function mergeSportsCategoryClips(filteredByCategory, categoryIds, limit) {
  const merged = [];
  const indices = Object.fromEntries(categoryIds.map(c => [c, 0]));
  const seen = new Set();

  while (merged.length < limit) {
    let added = false;
    for (const catId of categoryIds) {
      const pool = filteredByCategory[catId] || [];
      while (indices[catId] < pool.length) {
        const v = pool[indices[catId]++];
        const key = ((v.title || '') + (v.hlsUrl || '')).toLowerCase().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(v);
        added = true;
        break;
      }
      if (merged.length >= limit) break;
    }
    if (!added) break;
  }
  return merged;
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

  const perCatLimit = Math.max(3, Math.ceil((limit * 2) / Math.max(1, categoryIds.length || 1)));
  const clipsByCategory = Object.fromEntries(categoryIds.map(id => [id, []]));

  await mapPool(categoryIds, 4, async catId => {
    if (espnLeagues[catId]) {
      clipsByCategory[catId] = await espn.fetchLeagueHighlights({
        league: catId,
        limit: perCatLimit,
        dateYmd: opts.date || null,
      });
    } else if (bbcCats[catId] && opts.extractBbcVideo) {
      clipsByCategory[catId] = await bbcSport.fetchCategoryHighlights({
        categoryKey: catId,
        limit: perCatLimit,
        pubHours,
        extractVideo: opts.extractBbcVideo,
      });
    }
  });

  const filterOpts = { ...opts, pubHours: opts.pubHours != null ? opts.pubHours : pubHours };
  const filteredByCategory = {};
  const categoryBreakdownFetched = {};
  const categoryBreakdownMatched = {};
  for (const catId of categoryIds) {
    const raw = (clipsByCategory[catId] || []).map(v => ({ ...v, category: v.category || catId }));
    categoryBreakdownFetched[catId] = raw.length;
    let pool = applyClipFilters(raw, filterOpts);
    pool = sortSportsClips(pool, opts.targetSec || 30);
    filteredByCategory[catId] = pool;
    categoryBreakdownMatched[catId] = pool.length;
  }

  const videos = categoryIds.length > 1
    ? mergeSportsCategoryClips(filteredByCategory, categoryIds, limit)
    : (filteredByCategory[categoryIds[0]] || []).slice(0, limit);

  const categoryBreakdown = {};
  for (const v of videos) {
    const c = v.category || v.source || 'unknown';
    categoryBreakdown[c] = (categoryBreakdown[c] || 0) + 1;
  }

  return {
    videos,
    categoryBreakdown,
    categoryBreakdownMatched,
    categoryBreakdownFetched,
  };
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
