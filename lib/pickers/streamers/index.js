const { resolveStreamer, listPlatforms, streamerSources } = require('./config');
const { fetchTwitchClips } = require('./adapters/twitch');
const { fetchKickClips } = require('./adapters/kick');
const { fetchYoutubeClips } = require('./adapters/youtube');

function applyClipFilters(clips, { durMin, durMax, pubWindow, pubHours, pubHoursMin, pubHoursMax } = {}) {
  const { resolveClipPubWindow, clipInPubBand } = require('./clip_pub_window');
  const band = resolveClipPubWindow({ pubWindow, pubHours, pubHoursMin, pubHoursMax });
  return clips.filter(c => {
    const dur = Number(c.duration);
    if (durMin != null && (!Number.isFinite(dur) || dur < durMin)) return false;
    if (durMax != null && (!Number.isFinite(dur) || dur > durMax)) return false;
    if (band.minHours > 0 || band.maxHours != null) {
      if (!clipInPubBand(c.createdAt, band)) return false;
    }
    return !!c.url;
  });
}

/** Actionable drop reason when raw clips exist but filters remove all of them. */
function explainClipFilterDrop(rawClips, filters = {}) {
  if (!rawClips.length) return null;
  const { resolveClipPubWindow, clipCreatedAtMs } = require('./clip_pub_window');
  const { durMin, durMax, pubWindow, pubHours, pubHoursMin, pubHoursMax } = filters;
  const band = resolveClipPubWindow({ pubWindow, pubHours, pubHoursMin, pubHoursMax });

  let durFail = 0;
  let tooNew = 0;
  let tooOld = 0;
  for (const c of rawClips) {
    if (!c.url) continue;
    const dur = Number(c.duration);
    if (durMin != null && (!Number.isFinite(dur) || dur < durMin)) { durFail++; continue; }
    if (durMax != null && (!Number.isFinite(dur) || dur > durMax)) { durFail++; continue; }
    if (band.minHours > 0 || band.maxHours != null) {
      const t = clipCreatedAtMs(c.createdAt);
      if (Number.isFinite(t)) {
        const ageMs = Date.now() - t;
        const minMs = (band.minHours || 0) * 3600000;
        const maxMs = band.maxHours != null ? band.maxHours * 3600000 : Infinity;
        if (ageMs < minMs) tooNew++;
        else if (ageMs >= maxMs) tooOld++;
      }
    }
  }

  const n = rawClips.length;
  const bandLabel = band.label || pubWindow || 'age band';
  if (tooNew === n && band.minHours >= 24) {
    const minDays = Math.round(band.minHours / 24);
    return `No clips in age ${bandLabel} (${n} found — all newer than ${minDays}d; try last 7d or last 30d)`;
  }
  if (tooOld === n && band.maxHours != null) {
    const maxDays = Math.round(band.maxHours / 24);
    return `No clips in age ${bandLabel} (${n} found — all older than ${maxDays}d)`;
  }
  if (durFail > 0 && tooNew === 0 && tooOld === 0) {
    return `No clips match duration (${n} found — YouTube Shorts are often 15–45s; check min/max)`;
  }
  if (tooNew > 0 || tooOld > 0) {
    return `No clips match age ${bandLabel} (${n} found — ${tooNew} too new, ${tooOld} too old)`;
  }
  return `No clips match filters (${n} found)`;
}

async function fetchOneStreamer(entry, opts) {
  const { clipsPer, pubHours, pubWindow, pubHoursMin, pubHoursMax, durMin, durMax, clipSort, libraryMode } = opts;
  try {
    let result;
    if (entry.platform === 'kick') {
      result = await fetchKickClips(entry.login, { clipsPer });
    } else if (entry.platform === 'youtube') {
      result = await fetchYoutubeClips(entry.handle, {
        clipsPer,
        pubHours: pubHours != null ? pubHours : 168,
        pubWindow,
        pubHoursMin,
        pubHoursMax,
        channelId: entry.channelId || null,
        libraryMode: !!libraryMode,
      });
    } else {
      result = await fetchTwitchClips(entry.login, {
        clipsPer,
        pubWindow,
        pubHours: pubHours != null ? pubHours : null,
        pubHoursMin,
        pubHoursMax,
        strictWindow: pubWindow != null || pubHours != null,
        sort: clipSort || 'popular',
        libraryMode: !!libraryMode,
      });
    }

    const filtered = applyClipFilters(result.clips || [], {
      durMin, durMax, pubWindow, pubHours, pubHoursMin, pubHoursMax,
    });
    const rawCount = (result.clips || []).length;
    let dropReason = null;
    if (!filtered.length) {
      if (rawCount > 0) {
        dropReason = explainClipFilterDrop(result.clips || [], {
          durMin, durMax, pubWindow, pubHours, pubHoursMin, pubHoursMax,
        }) || `No clips match filters (${rawCount} found)`;
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
  } catch (err) {
    const msg = err.response?.status === 429
      ? 'Twitch rate limited — wait ~30s and retry'
      : (err.message || 'Fetch failed');
    return {
      login: entry.login,
      displayName: entry.displayName || entry.login,
      platform: entry.platform,
      clips: [],
      dropReason: msg,
    };
  }
}

async function fetchStreamerPickerClips({
  streamers = [],
  platforms = ['twitch', 'kick', 'youtube'],
  clipsPer = 2,
  pubHours = null,
  pubWindow = null,
  pubHoursMin = null,
  pubHoursMax = null,
  durMin = null,
  durMax = null,
  clipSort = 'popular',
  libraryMode = false,
} = {}) {
  const platformSet = new Set(platforms.map(p => p.toLowerCase()));
  const resolved = streamers
    .map(resolveStreamer)
    .filter(Boolean)
    .filter(s => platformSet.has(s.platform));

  const opts = {
    clipsPer, pubHours, pubWindow, pubHoursMin, pubHoursMax, durMin, durMax, clipSort, libraryMode,
  };
  const concurrency = 2;
  const out = [];
  for (let i = 0; i < resolved.length; i += concurrency) {
    const batch = resolved.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(entry => fetchOneStreamer(entry, opts)));
    out.push(...results);
    if (i + concurrency < resolved.length) {
      await new Promise(r => setTimeout(r, 350));
    }
  }
  return out;
}

const { fetchStreamerPickerVods } = require('./vods');
const { resolveClipUrl, detectPlatform } = require('./clip_resolve');

module.exports = {
  streamerSources,
  listPlatforms,
  resolveStreamer,
  fetchStreamerPickerClips,
  fetchStreamerPickerVods,
  resolveClipUrl,
  detectPlatform,
};
