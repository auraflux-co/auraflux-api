const { resolveStreamer, listPlatforms, streamerSources } = require('./config');
const { fetchTwitchClips } = require('./adapters/twitch');
const { fetchKickClips } = require('./adapters/kick');
const { fetchYoutubeClips } = require('./adapters/youtube');

function applyClipFilters(clips, { durMin, durMax, pubHours } = {}) {
  const pubSinceMs = pubHours != null && Number(pubHours) > 0
    ? Date.now() - Number(pubHours) * 3600000
    : null;
  return clips.filter(c => {
    const dur = Number(c.duration);
    if (durMin != null && (!Number.isFinite(dur) || dur < durMin)) return false;
    if (durMax != null && (!Number.isFinite(dur) || dur > durMax)) return false;
    if (pubSinceMs != null) {
      const t = new Date(c.createdAt || 0).getTime();
      if (!Number.isFinite(t) || t < pubSinceMs) return false;
    }
    return !!c.url;
  });
}

async function fetchOneStreamer(entry, opts) {
  const { clipsPer, pubHours, durMin, durMax } = opts;
  let result;
  if (entry.platform === 'kick') {
    result = await fetchKickClips(entry.login, { clipsPer });
  } else if (entry.platform === 'youtube') {
    result = await fetchYoutubeClips(entry.handle, {
      clipsPer,
      pubHours: pubHours || 168,
      channelId: entry.channelId || null,
    });
  } else {
    result = await fetchTwitchClips(entry.login, { clipsPer, pubHours: pubHours || 24 });
  }

  const filtered = applyClipFilters(result.clips || [], { durMin, durMax, pubHours });
  const rawCount = (result.clips || []).length;
  let dropReason = null;
  if (!filtered.length) {
    if (rawCount > 0) {
      dropReason = `No clips match filters (${rawCount} found — check min duration; YouTube Shorts are often 15–45s)`;
    } else {
      dropReason = result.dropReason || 'No clips match filters';
    }
  }
  return {
    login: entry.login,
    displayName: result.displayName || entry.displayName,
    platform: entry.platform,
    clips: filtered,
    dropReason,
  };
}

async function fetchStreamerPickerClips({
  streamers = [],
  platforms = ['twitch', 'kick', 'youtube'],
  clipsPer = 2,
  pubHours = null,
  durMin = null,
  durMax = null,
} = {}) {
  const platformSet = new Set(platforms.map(p => p.toLowerCase()));
  const resolved = streamers
    .map(resolveStreamer)
    .filter(Boolean)
    .filter(s => platformSet.has(s.platform));

  const opts = { clipsPer, pubHours, durMin, durMax };
  const concurrency = 4;
  const out = [];
  for (let i = 0; i < resolved.length; i += concurrency) {
    const batch = resolved.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(entry => fetchOneStreamer(entry, opts)));
    out.push(...results);
  }
  return out;
}

module.exports = {
  streamerSources,
  listPlatforms,
  resolveStreamer,
  fetchStreamerPickerClips,
};
