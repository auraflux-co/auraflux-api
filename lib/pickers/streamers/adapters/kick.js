const KickClient = require('../../../clients/kick_client');

async function fetchKickClips(login, { clipsPer = 3 } = {}) {
  const client = new KickClient();
  try {
    const raw = await client.getContent(login, Math.max(clipsPer * 4, 12), { type: 'clip' });
    const slug = String(login || '').toLowerCase();
    const clips = (raw || []).slice(0, 16).map(c => ({
      title: c.title || 'Clip',
      url: c.url && c.url.includes('/clips/')
        ? c.url
        : (c.id ? `https://kick.com/${slug}/clips/${c.id}` : c.url || ''),
      cdnUrl: c.cdnUrl || null,
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
      return { clips: [], dropReason: 'Kick unavailable (check kick_fetch.py / OAuth connect)' };
    }
    return { clips: [], dropReason: err.message || 'Kick fetch failed' };
  }
}

module.exports = { fetchKickClips };
