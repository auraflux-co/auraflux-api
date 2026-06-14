const streamerSources = require('../../../config/streamerSources.json');

function resolveStreamer(login) {
  const key = String(login || '').trim().toLowerCase();
  if (!key) return null;
  const cfg = streamerSources.streamers[key] || {};
  return {
    login: key,
    displayName: cfg.displayName || key,
    platform: cfg.platform || streamerSources.defaults.platform || 'twitch',
    handle: (cfg.handle || key).replace(/^@/, ''),
  };
}

function listPlatforms() {
  return Object.entries(streamerSources.platforms || {})
    .filter(([, v]) => v.enabled !== false)
    .map(([id, v]) => ({ id, label: v.label || id }));
}

module.exports = {
  streamerSources,
  resolveStreamer,
  listPlatforms,
};
