'use strict';
/** Recent VOD/replay fetch for streamer pillar (CPD-1053). */

const axios = require('axios');
const KickClient = require('../../clients/kick_client');
const YouTubeClient = require('../../clients/youtube_client');
const { resolveStreamer } = require('./config');

function parseTwitchDuration(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw);
  if (!raw || typeof raw !== 'string') return 0;
  const h = raw.match(/(\d+)h/i);
  const m = raw.match(/(\d+)m/i);
  const s = raw.match(/(\d+)s/i);
  return (h ? parseInt(h[1], 10) * 3600 : 0)
    + (m ? parseInt(m[1], 10) * 60 : 0)
    + (s ? parseInt(s[1], 10) : 0);
}

async function fetchTwitchVods(login, { limit = 5 } = {}) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = process.env.TWITCH_TOKEN;
  if (!clientId || !token) throw new Error('TWITCH_CLIENT_ID / TWITCH_TOKEN not set');

  const userResp = await axios.get(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }, timeout: 10000 }
  );
  const user = userResp.data?.data?.[0];
  if (!user) return { vods: [], dropReason: 'Twitch user not found' };

  const resp = await axios.get(
    `https://api.twitch.tv/helix/videos?user_id=${user.id}&type=archive&first=${Math.min(limit, 20)}`,
    { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }, timeout: 10000 }
  );
  const vods = (resp.data?.data || []).map((v) => ({
    title: v.title || 'VOD',
    url: v.url || `https://www.twitch.tv/videos/${v.id}`,
    thumbnailUrl: v.thumbnail_url?.replace('%{width}', '320').replace('%{height}', '180') || '',
    duration: parseTwitchDuration(v.duration),
    views: v.view_count || 0,
    createdAt: v.created_at || null,
    platform: 'twitch',
    contentType: 'vod',
    streamer: login,
    displayName: user.display_name || login,
    vod_id: v.id,
  }));
  return { vods, displayName: user.display_name || login };
}

async function fetchKickVods(login, { limit = 5 } = {}) {
  const client = new KickClient();
  const raw = await client.getVideos(login, Math.min(limit, 20));
  const vods = (raw || []).slice(0, limit).map((v) => ({
    title: v.title || 'VOD',
    url: v.url || '',
    thumbnailUrl: v.thumbnailUrl || '',
    duration: Math.round(v.duration || 0),
    views: v.viewCount || 0,
    createdAt: v.publishedAt || null,
    platform: 'kick',
    contentType: 'vod',
    streamer: login,
    displayName: login,
  }));
  if (!vods.length) return { vods: [], dropReason: 'No Kick VODs found' };
  return { vods };
}

async function fetchYoutubeVods(handle, { limit = 5, channelId = null } = {}) {
  if (!process.env.YOUTUBE_API_KEY) {
    return { vods: [], dropReason: 'YOUTUBE_API_KEY not set' };
  }
  const client = new YouTubeClient();
  let channel = channelId ? await client.getChannelById(channelId) : null;
  if (!channel && handle) channel = await client.getChannelByHandle(handle);
  if (!channel) return { vods: [], dropReason: 'YouTube channel not found' };

  const raw = await client.getContent(channel.id, Math.max(limit * 2, 10), { type: 'all' });
  const vods = (raw || [])
    .filter((v) => (v.duration || 0) > 120)
    .slice(0, limit)
    .map((v) => ({
      title: v.title || 'Video',
      url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
      thumbnailUrl: v.thumbnailUrl || '',
      duration: Math.round(v.duration || 0),
      views: v.viewCount || 0,
      createdAt: v.publishedAt || null,
      platform: 'youtube',
      contentType: 'vod',
      streamer: channel.handle || handle || channel.id,
      displayName: channel.title || handle || channel.id,
    }));
  return { vods, displayName: channel.title || handle || channel.id };
}

async function fetchOneStreamerVods(entry, opts) {
  const limit = opts.limit || 5;
  try {
    if (entry.platform === 'kick') return { ...(await fetchKickVods(entry.login, { limit })), login: entry.login, platform: 'kick', displayName: entry.displayName };
    if (entry.platform === 'youtube') {
      return {
        ...(await fetchYoutubeVods(entry.handle, { limit, channelId: entry.channelId })),
        login: entry.login,
        platform: 'youtube',
      };
    }
    return { ...(await fetchTwitchVods(entry.login, { limit })), login: entry.login, platform: 'twitch' };
  } catch (err) {
    return { login: entry.login, platform: entry.platform, displayName: entry.displayName, vods: [], dropReason: err.message };
  }
}

async function fetchStreamerPickerVods({
  streamers = [],
  platforms = ['twitch', 'kick', 'youtube'],
  limit = 5,
} = {}) {
  const platformSet = new Set(platforms.map((p) => p.toLowerCase()));
  const resolved = streamers.map(resolveStreamer).filter(Boolean).filter((s) => platformSet.has(s.platform));
  const out = [];
  for (let i = 0; i < resolved.length; i += 4) {
    const batch = resolved.slice(i, i + 4);
    const results = await Promise.all(batch.map((entry) => fetchOneStreamerVods(entry, { limit })));
    out.push(...results);
  }
  return out;
}

module.exports = {
  fetchTwitchVods,
  fetchKickVods,
  fetchYoutubeVods,
  fetchStreamerPickerVods,
  parseTwitchDuration,
};
