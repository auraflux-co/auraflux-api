const axios = require('axios');

async function fetchTwitchClips(login, { clipsPer = 3, pubHours = 24 } = {}) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = process.env.TWITCH_TOKEN;
  if (!clientId || !token) {
    throw new Error('TWITCH_CLIENT_ID / TWITCH_TOKEN not set');
  }

  const userResp = await axios.get(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }, timeout: 10000 }
  );
  const user = userResp.data?.data?.[0];
  if (!user) return { clips: [], dropReason: 'Twitch user not found' };

  const fetchWindow = Math.max(clipsPer * 6, 24);
  const sincePrimary = new Date(Date.now() - pubHours * 3600000).toISOString();
  const sinceFallback = new Date(Date.now() - Math.max(pubHours * 2, 168) * 3600000).toISOString();

  const fetchClips = async (sinceIso) => {
    const resp = await axios.get(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&first=${fetchWindow}&started_at=${encodeURIComponent(sinceIso)}`,
      { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    return resp.data?.data || [];
  };

  let raw = await fetchClips(sincePrimary);
  if (!raw.length) raw = await fetchClips(sinceFallback);

  const clips = raw.slice(0, 16).map(c => ({
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

module.exports = { fetchTwitchClips };
