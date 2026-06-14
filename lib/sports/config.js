const sportsSources = require('../../config/sportsSources.json');
const discovery = require('./adapters/espn_discovery');

async function getEspnLeaguesAsync(forceDiscovery = false) {
  const reg = await discovery.getEspnRegistry(forceDiscovery);
  const out = {};
  for (const [id, cfg] of Object.entries(reg.leagues)) {
    out[id] = { ...cfg, provider: 'espn' };
  }
  return out;
}

function getEspnLeagues() {
  const reg = discovery.getEspnRegistrySync();
  const out = {};
  for (const [id, cfg] of Object.entries(reg.leagues)) {
    out[id] = { ...cfg, provider: 'espn' };
  }
  return out;
}

function resolveEspnCategoryId(rawKey) {
  const reg = discovery.getEspnRegistrySync();
  return discovery.resolveEspnLeagueKey(rawKey, reg);
}

function getBbcCategories() {
  const out = {};
  for (const [key, cfg] of Object.entries(sportsSources.bbcCategories || {})) {
    out[key] = {
      label: cfg.label,
      rssUrl: cfg.rssUrl,
      provider: 'bbc',
    };
  }
  return out;
}

function getProbeWindowHours() {
  return sportsSources.probeWindowHours || 48;
}

module.exports = {
  sportsSources,
  getEspnLeagues,
  getEspnLeaguesAsync,
  resolveEspnCategoryId,
  getBbcCategories,
  getProbeWindowHours,
  discovery,
};
