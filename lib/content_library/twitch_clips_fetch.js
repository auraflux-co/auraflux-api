'use strict';

const { sharedTwitchClient } = require('../pickers/streamers/adapters/twitch');

async function fetchAllTwitchClipsInWindow(login, { startedAt, endedAt, maxPages = 10, pageSize = 100 } = {}) {
  const client = sharedTwitchClient();
  if (!client.clientId || !client.token) {
    throw new Error('TWITCH_CLIENT_ID / TWITCH_TOKEN not set');
  }

  const userResp = await client.helixGetWithRetry(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    `users:${login}`,
  );
  const user = userResp.data?.data?.[0];
  if (!user) return { clips: [], dropReason: 'Twitch user not found', displayName: login };

  const first = Math.min(Math.max(pageSize, 1), 100);
  const all = [];
  let cursor = null;
  let pages = 0;

  while (pages < maxPages) {
    const params = new URLSearchParams({
      broadcaster_id: user.id,
      first: String(first),
    });
    if (startedAt) params.set('started_at', startedAt);
    if (endedAt) params.set('ended_at', endedAt);
    else if (startedAt && !endedAt) params.set('ended_at', new Date().toISOString());
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

  all.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));

  const clips = all.map((c) => ({
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

  return { clips, displayName: user.display_name || login, pages };
}

module.exports = { fetchAllTwitchClipsInWindow };
