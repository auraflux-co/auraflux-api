const YouTubeClient = require('../../../clients/youtube_client');

async function fetchYoutubeClips(handle, { clipsPer = 3, pubHours = 168 } = {}) {
  if (!process.env.YOUTUBE_API_KEY) {
    return { clips: [], dropReason: 'YOUTUBE_API_KEY not set' };
  }
  try {
    const client = new YouTubeClient();
    const channel = await client.getChannelByHandle(handle);
    if (!channel) return { clips: [], dropReason: 'YouTube channel not found' };

    const publishedAfter = pubHours > 0
      ? new Date(Date.now() - pubHours * 3600000).toISOString()
      : null;
    const raw = await client.getContent(channel.id, Math.max(clipsPer * 4, 12), {
      publishedAfter,
      type: 'all',
    });

    const clips = (raw || [])
      .filter(v => (v.duration || 0) <= 600)
      .slice(0, 16)
      .map(v => ({
        title: v.title || 'Video',
        url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
        thumbnailUrl: v.thumbnailUrl || '',
        duration: Math.round(v.duration || 0),
        views: v.viewCount || 0,
        game: '',
        createdAt: v.publishedAt || null,
        platform: 'youtube',
        streamer: handle,
        displayName: channel.title || handle,
      }));

    if (!clips.length) return { clips: [], dropReason: 'No recent YouTube videos', displayName: channel.title || handle };
    return { clips, displayName: channel.title || handle };
  } catch (err) {
    return { clips: [], dropReason: err.message || 'YouTube fetch failed' };
  }
}

module.exports = { fetchYoutubeClips };
