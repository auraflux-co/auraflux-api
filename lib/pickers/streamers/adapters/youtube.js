const YouTubeClient = require('../../../clients/youtube_client');

async function fetchYoutubeClips(handle, {
  clipsPer = 3,
  pubHours = 168,
  pubWindow = null,
  pubHoursMin = null,
  pubHoursMax = null,
  channelId = null,
  libraryMode = false,
} = {}) {
  if (!process.env.YOUTUBE_API_KEY) {
    return { clips: [], dropReason: 'YOUTUBE_API_KEY not set' };
  }
  try {
    const { resolveClipPubWindow } = require('../clip_pub_window');
    const band = resolveClipPubWindow({ pubWindow, pubHours, pubHoursMin, pubHoursMax });
    const lookbackHours = band.maxHours != null
      ? band.maxHours
      : (Number.isFinite(pubHours) && pubHours > 0 ? pubHours : 720);

    const client = new YouTubeClient();
    let channel = null;
    if (channelId) {
      channel = await client.getChannelById(channelId);
    }
    if (!channel && handle) {
      channel = await client.getChannelByHandle(handle);
    }
    if (!channel) return { clips: [], dropReason: 'YouTube channel not found' };

    const publishedAfter = lookbackHours > 0
      ? new Date(Date.now() - lookbackHours * 3600000).toISOString()
      : null;
    const fetchCap = libraryMode ? 50 : Math.max(clipsPer * 4, 12);
    const raw = await client.getContent(channel.id, fetchCap, {
      publishedAfter,
      type: 'all',
    });

    const returnCap = libraryMode ? 50 : 16;
    const clips = (raw || [])
      .filter(v => (v.duration || 0) <= 600)
      .sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))
      .slice(0, returnCap)
      .map(v => ({
        title: v.title || 'Video',
        url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
        thumbnailUrl: v.thumbnailUrl || '',
        duration: Math.round(v.duration || 0),
        views: v.viewCount || 0,
        game: '',
        createdAt: v.publishedAt || null,
        platform: 'youtube',
        streamer: channel.handle || handle || channel.id,
        displayName: channel.title || handle || channel.id,
      }));

    if (!clips.length) {
      return {
        clips: [],
        dropReason: `No YouTube uploads in last ${pubHours || '∞'}h`,
        displayName: channel.title || handle || channel.id,
      };
    }
    return { clips, displayName: channel.title || handle || channel.id };
  } catch (err) {
    return { clips: [], dropReason: err.message || 'YouTube fetch failed' };
  }
}

module.exports = { fetchYoutubeClips };
