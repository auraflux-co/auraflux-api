'use strict';
/** Recent VOD/replay fetch for streamer pillar (CPD-1053 / CPD-1288 window). */

const axios = require('axios');
const KickClient = require('../../clients/kick_client');
const YouTubeClient = require('../../clients/youtube_client');
const { resolveStreamer } = require('./config');
const { resolveClipPubWindow, clipInPubBand } = require('./clip_pub_window');

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

function filterVodsByPubWindow(vods, pubBand) {
  if (!pubBand) return vods || [];
  return (vods || []).filter((v) => clipInPubBand(v.createdAt, pubBand));
}

async function fetchTwitchVods(login, { limit = 5, pubBand = null } = {}) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = process.env.TWITCH_TOKEN;
  if (!clientId || !token) throw new Error('TWITCH_CLIENT_ID / TWITCH_TOKEN not set');

  const userResp = await axios.get(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }, timeout: 10000 }
  );
  const user = userResp.data?.data?.[0];
  if (!user) return { vods: [], dropReason: 'Twitch user not found' };

  const fetchN = Math.min(pubBand ? 50 : Math.max(limit, 5), 50);
  const resp = await axios.get(
    `https://api.twitch.tv/helix/videos?user_id=${user.id}&type=archive&first=${fetchN}`,
    { headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` }, timeout: 10000 }
  );
  let vods = (resp.data?.data || []).map((v) => ({
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
  vods = filterVodsByPubWindow(vods, pubBand).slice(0, limit);
  if (!vods.length && pubBand) {
    return { vods: [], displayName: user.display_name || login, dropReason: `No VODs in ${pubBand.label}` };
  }
  return { vods, displayName: user.display_name || login };
}

async function fetchKickVods(login, { limit = 5, pubBand = null } = {}) {
  const client = new KickClient();
  const fetchN = Math.min(pubBand ? 50 : Math.max(limit, 5), 50);
  const raw = await client.getVideos(login, fetchN);
  let vods = (raw || []).map((v) => ({
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
  vods = filterVodsByPubWindow(vods, pubBand).slice(0, limit);
  if (!vods.length) {
    return {
      vods: [],
      dropReason: pubBand ? `No Kick VODs in ${pubBand.label}` : 'No Kick VODs found',
    };
  }
  return { vods };
}

async function fetchYoutubeVods(handle, { limit = 5, channelId = null, pubBand = null } = {}) {
  if (!process.env.YOUTUBE_API_KEY) {
    return { vods: [], dropReason: 'YOUTUBE_API_KEY not set' };
  }
  const client = new YouTubeClient();
  let channel = channelId ? await client.getChannelById(channelId) : null;
  if (!channel && handle) channel = await client.getChannelByHandle(handle);
  if (!channel) return { vods: [], dropReason: 'YouTube channel not found' };

  // Pull a wider recent page when date-banding so post-filter still fills `limit`.
  const fetchN = Math.min(pubBand ? 50 : Math.max(limit * 2, 10), 50);
  const contentOpts = { type: 'all' };
  if (pubBand?.startedAt) contentOpts.publishedAfter = pubBand.startedAt;
  const raw = await client.getContent(channel.id, fetchN, contentOpts);
  let vods = (raw || [])
    .filter((v) => (v.duration || 0) > 120) // long-form only — Shorts excluded
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
      vod_id: v.id,
    }));
  vods = filterVodsByPubWindow(vods, pubBand).slice(0, limit);
  if (!vods.length && pubBand) {
    return {
      vods: [],
      displayName: channel.title || handle || channel.id,
      dropReason: `No long-form VODs in ${pubBand.label}`,
    };
  }
  return { vods, displayName: channel.title || handle || channel.id };
}

async function fetchOneStreamerVods(entry, opts) {
  const limit = opts.limit || 5;
  const pubBand = opts.pubBand || null;
  try {
    if (entry.platform === 'kick') {
      return {
        ...(await fetchKickVods(entry.login, { limit, pubBand })),
        login: entry.login,
        platform: 'kick',
        displayName: entry.displayName,
      };
    }
    if (entry.platform === 'youtube') {
      return {
        ...(await fetchYoutubeVods(entry.handle, { limit, channelId: entry.channelId, pubBand })),
        login: entry.login,
        platform: 'youtube',
      };
    }
    return {
      ...(await fetchTwitchVods(entry.login, { limit, pubBand })),
      login: entry.login,
      platform: 'twitch',
    };
  } catch (err) {
    return {
      login: entry.login,
      platform: entry.platform,
      displayName: entry.displayName,
      vods: [],
      dropReason: err.message,
    };
  }
}

async function fetchStreamerPickerVods({
  streamers = [],
  platforms = ['twitch', 'kick', 'youtube'],
  limit = 5,
  window = 'last7d',
  pubWindow = null,
} = {}) {
  const platformSet = new Set(platforms.map((p) => p.toLowerCase()));
  const resolved = streamers.map(resolveStreamer).filter(Boolean).filter((s) => platformSet.has(s.platform));
  const winKey = pubWindow || window || 'last7d';
  // `any` = no date band (legacy / debug). Default operator pills use last7d / last30d / all.
  const pubBand = winKey === 'any'
    ? null
    : resolveClipPubWindow({ pubWindow: winKey });
  const out = [];
  for (let i = 0; i < resolved.length; i += 4) {
    const batch = resolved.slice(i, i + 4);
    const results = await Promise.all(
      batch.map((entry) => fetchOneStreamerVods(entry, { limit, pubBand })),
    );
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
  filterVodsByPubWindow,
};
