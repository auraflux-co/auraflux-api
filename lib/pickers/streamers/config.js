const streamerSources = require('../../../config/streamerSources.json');
const { resolveTwitchLogin } = require('../../streamer_login');

function resolveStreamer(login) {
  const key = resolveTwitchLogin(login);
  if (!key) return null;

  // CPD-1027: registry is canonical; streamerSources.json is fallback seed
  try {
    const { resolveForPicker } = require('../../creator_registry');
    const fromReg = resolveForPicker(key);
    const cfg = streamerSources.streamers[key] || {};
    const cfgPlatform = cfg.platform;
    if (fromReg && fromReg.kind === 'streamer') {
      return {
        login: key,
        displayName: cfg.displayName || fromReg.displayName || key,
        platform: fromReg.platform || cfgPlatform || 'twitch',
        handle: (fromReg.handle || key).replace(/^@/, ''),
        channelId: fromReg.channelId || null,
      };
    }
  } catch (_) { /* registry optional at boot */ }

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
