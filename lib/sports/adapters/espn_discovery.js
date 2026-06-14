/**
 * Discover ESPN leagues from site APIs — maps web URL segments
 * (e.g. /soccer/worldcup/) to scoreboard paths (soccer/fifa.world).
 */
const axios = require('axios');
const sportsSources = require('../../../config/sportsSources.json');

const ESPN_SPORTS = sportsSources.espnSportSlugs || [
  'basketball', 'football', 'baseball', 'hockey', 'soccer',
  'golf', 'racing', 'mma', 'tennis',
];

const CACHE_MS = (sportsSources.espnDiscoveryCacheHours || 6) * 3600000;
let _cache = { ts: 0, leagues: null, loading: null };

function desktopHref(league) {
  const links = league.links || [];
  return links.find(l => (l.rel || []).includes('desktop') && l.href)?.href
    || links.find(l => l.href?.startsWith('http'))?.href
    || '';
}

/** Parse espn.com path segment(s) from league index URL. */
function parseWebSegments(href, sportSlug) {
  if (!href) return [];
  const out = [];
  const soccerShort = href.match(/espn\.com\/soccer\/([^/?#]+)\/?$/i);
  if (soccerShort) out.push(soccerShort[1].toLowerCase());

  const leagueName = href.match(/\/league\/_\/name\/([^/?#]+)/i);
  if (leagueName) out.push(leagueName[1].toLowerCase());

  const topLevel = href.match(/espn\.com\/([a-z0-9-]+)\/?$/i);
  if (topLevel && topLevel[1] !== sportSlug) out.push(topLevel[1].toLowerCase());

  return [...new Set(out.filter(Boolean))];
}

function defaultMaxClipSec(sportSlug) {
  if (sportSlug === 'soccer') return 300;
  if (sportSlug === 'football') return 300;
  if (sportSlug === 'mma') return 300;
  return 600;
}

function mergeStaticOverrides(discovered) {
  const overrides = sportsSources.espnLeagueOverrides || {};
  for (const [key, cfg] of Object.entries(overrides)) {
    if (discovered[key]) {
      discovered[key] = { ...discovered[key], ...cfg };
    } else if (cfg.path) {
      const [sport, ...rest] = cfg.path.split('/');
      discovered[key] = {
        id: key,
        label: cfg.label || key,
        path: cfg.path,
        sport: sport || 'unknown',
        leagueSlug: rest.join('/') || key,
        webSegments: [key],
        webUrl: cfg.webUrl || '',
        maxClipSec: cfg.maxClipSec || defaultMaxClipSec(sport),
        provider: 'espn',
      };
    }
  }
  return discovered;
}

function buildAliasMap(leagues) {
  const aliases = { ...(sportsSources.espnAliases || {}) };
  for (const [id, cfg] of Object.entries(leagues)) {
    for (const seg of cfg.webSegments || []) {
      if (seg !== id) aliases[seg] = id;
    }
    // slug with dots → underscore alias (fifa.world → fifa_world)
    const underscored = id.replace(/\./g, '_');
    if (underscored !== id) aliases[underscored] = id;
  }
  // legacy dashboard keys
  aliases.worldcup = aliases.worldcup || 'fifa.world';
  aliases.epl = aliases.epl || 'eng.1';
  aliases.ucl = aliases.ucl || 'uefa.champions';
  aliases.laliga = aliases.laliga || 'esp.1';
  aliases.bundesliga = aliases.bundesliga || 'ger.1';
  aliases.seriea = aliases.seriea || 'ita.1';
  aliases.ligue1 = aliases.ligue1 || 'fra.1';
  aliases.ncaam = aliases.ncaam || 'mens-college-basketball';
  aliases.ncaaw = aliases.ncaaw || 'womens-college-basketball';
  aliases.nascar = aliases.nascar || 'nascar-premier';
  return aliases;
}

async function fetchSportDropdown(sportSlug) {
  const url = `https://site.api.espn.com/apis/site/v2/leagues/dropdown?sport=${sportSlug}`;
  const resp = await axios.get(url, { timeout: 15000 });
  return resp.data?.leagues || [];
}

async function discoverEspnLeagues(force = false) {
  if (!force && _cache.leagues && Date.now() - _cache.ts < CACHE_MS) {
    return _cache.leagues;
  }
  if (_cache.loading) return _cache.loading;

  _cache.loading = (async () => {
    const leagues = {};
    for (const sportSlug of ESPN_SPORTS) {
      let items = [];
      try {
        items = await fetchSportDropdown(sportSlug);
      } catch (err) {
        console.warn(`[espn_discovery] dropdown failed for ${sportSlug}:`, err.message);
      }
      for (const lg of items) {
        const leagueSlug = lg.slug;
        if (!leagueSlug) continue;
        const href = desktopHref(lg);
        const webSegments = parseWebSegments(href, sportSlug);
        const id = leagueSlug;
        leagues[id] = {
          id,
          label: lg.abbreviation || lg.shortName || lg.name || id,
          path: `${sportSlug}/${leagueSlug}`,
          sport: sportSlug,
          leagueSlug,
          webSegments,
          webUrl: href,
          maxClipSec: defaultMaxClipSec(sportSlug),
          provider: 'espn',
        };
      }
    }
    mergeStaticOverrides(leagues);
    const aliases = buildAliasMap(leagues);
    const payload = { leagues, aliases, discoveredAt: new Date().toISOString(), count: Object.keys(leagues).length };
    _cache.leagues = payload;
    _cache.ts = Date.now();
    _cache.loading = null;
    console.log(`[espn_discovery] ${payload.count} ESPN leagues indexed (${ESPN_SPORTS.length} sports)`);
    return payload;
  })();

  return _cache.loading;
}

function staticFallbackLeagues() {
  const leagues = {};
  for (const [key, cfg] of Object.entries(sportsSources.espnLeagues || {})) {
    const [sport, ...rest] = (cfg.path || '').split('/');
    leagues[key] = {
      id: key,
      label: cfg.label,
      path: cfg.path,
      sport: sport || 'unknown',
      leagueSlug: rest.join('/') || key,
      webSegments: [key],
      webUrl: cfg.webUrl || '',
      maxClipSec: cfg.maxClipSec || 600,
      provider: 'espn',
    };
  }
  mergeStaticOverrides(leagues);
  return { leagues, aliases: buildAliasMap(leagues), discoveredAt: null, count: Object.keys(leagues).length };
}

async function getEspnRegistry(force = false) {
  try {
    return await discoverEspnLeagues(force);
  } catch (err) {
    console.warn('[espn_discovery] using static fallback:', err.message);
    return staticFallbackLeagues();
  }
}

function getEspnRegistrySync() {
  return _cache.leagues || staticFallbackLeagues();
}

function resolveEspnLeagueKey(rawKey, registry) {
  const key = String(rawKey || '').trim().toLowerCase();
  if (!key) return null;
  const reg = registry || getEspnRegistrySync();
  const { leagues, aliases } = reg;
  if (leagues[key]) return key;
  if (aliases[key]) return aliases[key];
  // match web segment (worldcup → fifa.world)
  for (const [id, cfg] of Object.entries(leagues)) {
    if ((cfg.webSegments || []).includes(key)) return id;
  }
  return null;
}

function clearDiscoveryCache() {
  _cache.ts = 0;
  _cache.leagues = null;
  _cache.loading = null;
}

module.exports = {
  ESPN_SPORTS,
  parseWebSegments,
  discoverEspnLeagues,
  getEspnRegistry,
  getEspnRegistrySync,
  resolveEspnLeagueKey,
  clearDiscoveryCache,
};
