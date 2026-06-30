const TwitchClient = require('../../../clients/twitch_client');

let _sharedClient = null;
function sharedTwitchClient() {
  if (!_sharedClient) _sharedClient = new TwitchClient();
  return _sharedClient;
}

async function fetchTwitchClips(login, {
  clipsPer = 3,
  pubHours = null,
  pubWindow = null,
  pubHoursMin = null,
  pubHoursMax = null,
  strictWindow = true,
  sort = 'popular',
  libraryMode = false,
} = {}) {
  const client = sharedTwitchClient();
  if (!client.clientId || !client.token) {
    throw new Error('TWITCH_CLIENT_ID / TWITCH_TOKEN not set');
  }

  const userResp = await client.helixGetWithRetry(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    `users:${login}`,
  );
  const user = userResp.data?.data?.[0];
  if (!user) return { clips: [], dropReason: 'Twitch user not found' };

  const { resolveClipPubWindow, clipInPubBand } = require('../clip_pub_window');
  const band = resolveClipPubWindow({ pubWindow, pubHours, pubHoursMin, pubHoursMax });
  const { startedAt, endedAt } = band;

  const pickerCap = Math.min(Math.max(parseInt(process.env.TWITCH_PICKER_CLIP_CAP, 10) || 100, 8), 100);
  const libraryCap = Math.min(Math.max(parseInt(process.env.TWITCH_LIBRARY_CLIP_CAP, 10) || 500, 50), 2000);
  const first = libraryMode ? 100 : Math.min(Math.max(clipsPer * 2, pickerCap), 100);
  const all = [];
  let cursor = null;
  let pages = 0;
  const maxPages = libraryMode ? 20 : (band.maxHours == null ? 10 : (band.maxHours >= 720 ? 10 : band.maxHours >= 168 ? 8 : 5));

  while (pages < maxPages) {
    const params = new URLSearchParams({ broadcaster_id: user.id, first: String(first) });
    if (startedAt) params.set('started_at', startedAt);
    if (endedAt) params.set('ended_at', endedAt);
    if (cursor) params.set('after', cursor);
    const resp = await client.helixGetWithRetry(
      `https://api.twitch.tv/helix/clips?${params.toString()}`,
      `clips:${login}:p${pages}`,
    );
    const batch = resp.data?.data || [];
    all.push(...batch);
    cursor = resp.data?.pagination?.cursor;
    pages += 1;
    if (!cursor || !batch.length) break;
    await new Promise((r) => setTimeout(r, 120));
  }

  if (!all.length && !strictWindow && pubHours) {
    const fallbackHours = Math.max(pubHours * 2, 168);
    const fbSince = new Date(Date.now() - fallbackHours * 3600000).toISOString();
    const fbEnded = new Date().toISOString();
    const resp = await client.helixGetWithRetry(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=${first}&started_at=${encodeURIComponent(fbSince)}&ended_at=${encodeURIComponent(fbEnded)}`,
      `clips:${login}:fallback`,
    );
    all.push(...(resp.data?.data || []));
  }

  const inBand = all.filter((c) => clipInPubBand(c.created_at, band));

  if (sort === 'recent') {
    inBand.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } else {
    inBand.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
  }

  const returnCap = libraryMode ? libraryCap : Math.max(clipsPer, pickerCap);
  const clips = inBand.slice(0, returnCap).map((c) => ({
    title: c.title || 'Clip',
    url: c.url || '',
    thumbnailUrl: c.thumbnail_url || '',
    duration: Math.round(c.duration || 0),
    views: c.view_count || 0,
    game: c.game_id || '',
    createdAt: c.created_at || null,
    platform: 'twitch',
    streamer: login,
    displayName: user.display_name || login,
    clip_id: c.id || '',
  }));

  if (!clips.length) {
    const label = band.label || (pubHours != null ? `${pubHours}h` : 'ALL');
    const hint = band.minHours > 0
      ? ' — excludes newer clips; try Last 7D for Twitch-style range'
      : '';
    return { clips: [], dropReason: `No Twitch clips in ${label} window${hint}`, displayName: user.display_name || login };
  }
  return { clips, displayName: user.display_name || login, band: band.label, totalInBand: inBand.length };
}

module.exports = { fetchTwitchClips, sharedTwitchClient };
