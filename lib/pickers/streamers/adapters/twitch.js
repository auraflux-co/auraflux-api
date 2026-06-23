const TwitchClient = require('../../../clients/twitch_client');

let _sharedClient = null;
function sharedTwitchClient() {
  if (!_sharedClient) _sharedClient = new TwitchClient();
  return _sharedClient;
}

async function fetchTwitchClips(login, { clipsPer = 3, pubHours = 24 } = {}) {
  const client = sharedTwitchClient();
  if (!client.clientId || !client.token) {
    throw new Error('TWITCH_CLIENT_ID / TWITCH_TOKEN not set');
  }

  const userResp = await client.helixGetWithRetry(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    `users:${login}`
  );
  const user = userResp.data?.data?.[0];
  if (!user) return { clips: [], dropReason: 'Twitch user not found' };

  // Helix first= is capped at 100; keep modest to avoid 429 bursts (picker only needs top N).
  const fetchWindow = Math.min(Math.max(clipsPer * 2, 8), 30);
  const sincePrimary = new Date(Date.now() - pubHours * 3600000).toISOString();
  const sinceFallback = new Date(Date.now() - Math.max(pubHours * 2, 168) * 3600000).toISOString();

  const fetchClips = async (sinceIso) => {
    const resp = await client.helixGetWithRetry(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=${fetchWindow}&started_at=${encodeURIComponent(sinceIso)}`,
      `clips:${login}`
    );
    return resp.data?.data || [];
  };

  let raw = await fetchClips(sincePrimary);
  if (!raw.length) raw = await fetchClips(sinceFallback);

  raw.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));

  const clips = raw.slice(0, Math.max(clipsPer, 8)).map(c => ({
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
  }));

  if (!clips.length) {
    return { clips: [], dropReason: `No Twitch clips in ${pubHours}h window`, displayName: user.display_name || login };
  }
  return { clips, displayName: user.display_name || login };
}

module.exports = { fetchTwitchClips, sharedTwitchClient };
