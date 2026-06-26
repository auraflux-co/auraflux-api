const TwitchClient = require('../../../clients/twitch_client');

let _sharedClient = null;
function sharedTwitchClient() {
  if (!_sharedClient) _sharedClient = new TwitchClient();
  return _sharedClient;
}

async function fetchTwitchClips(login, { clipsPer = 3, pubHours = 24, strictWindow = true } = {}) {
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

  const pickerCap = Math.min(Math.max(parseInt(process.env.TWITCH_PICKER_CLIP_CAP, 10) || 100, 8), 100);
  const sinceMs = pubHours != null && pubHours > 0
    ? Date.now() - pubHours * 3600000
    : null;
  const startedAt = sinceMs != null ? new Date(sinceMs).toISOString() : null;

  const first = Math.min(Math.max(clipsPer * 2, pickerCap), 100);
  const all = [];
  let cursor = null;
  let pages = 0;
  const maxPages = pubHours == null ? 10 : 5;

  while (pages < maxPages) {
    const params = new URLSearchParams({ broadcaster_id: user.id, first: String(first) });
    if (startedAt) params.set('started_at', startedAt);
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

  if (!all.length && !strictWindow) {
    const fallbackHours = Math.max(pubHours * 2, 168);
    const fbSince = new Date(Date.now() - fallbackHours * 3600000).toISOString();
    const resp = await client.helixGetWithRetry(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=${first}&started_at=${encodeURIComponent(fbSince)}`,
      `clips:${login}:fallback`,
    );
    all.push(...(resp.data?.data || []));
  }

  all.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));

  const returnCap = Math.max(clipsPer, pickerCap);
  const clips = all.slice(0, returnCap).map((c) => ({
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
    const label = pubHours != null ? `${pubHours}h` : 'ALL';
    return { clips: [], dropReason: `No Twitch clips in ${label} window`, displayName: user.display_name || login };
  }
  return { clips, displayName: user.display_name || login };
}

module.exports = { fetchTwitchClips, sharedTwitchClient };
