const KickClient = require('../../../clients/kick_client');

async function fetchKickClips(login, { clipsPer = 3 } = {}) {
  const client = new KickClient();
  try {
    const raw = await client.getContent(login, Math.max(clipsPer * 4, 12), { type: 'clip' });
    const clips = (raw || []).slice(0, 16).map(c => ({
      title: c.title || 'Clip',
      url: c.url || '',
      thumbnailUrl: c.thumbnailUrl || '',
      duration: Math.round(c.duration || 0),
      views: c.viewCount || 0,
      game: '',
      createdAt: c.publishedAt || null,
      platform: 'kick',
      streamer: login,
      displayName: login,
    }));
    if (!clips.length) return { clips: [], dropReason: 'No Kick clips found' };
    return { clips };
  } catch (err) {
    if (err.isKickUnavailable) {
      return { clips: [], dropReason: 'Kick unavailable (connect OAuth or set APIFY_API_TOKEN)' };
    }
    return { clips: [], dropReason: err.message || 'Kick fetch failed' };
  }
}

module.exports = { fetchKickClips };
