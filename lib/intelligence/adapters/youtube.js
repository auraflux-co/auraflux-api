'use strict';
/**
 * CPD-1191 — YouTube adapter for Content Memory performance sync.
 * Reuses lib/services/channel_analytics.js (no duplicate Analytics API client).
 */

const memory = require('../memory');

function extractVideoId(urlOrId) {
  if (!urlOrId) return null;
  const s = String(urlOrId);
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function fetchDataApiFallback(videoId) {
  try {
    const { getVideoStatistics } = require('../../services/youtube_direct');
    const stats = await getVideoStatistics(videoId);
    if (!stats || !stats.viewCount) return null;
    return {
      views: stats.viewCount,
      likes: stats.likeCount || 0,
      source: 'data_api',
      syncedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

async function syncVideoPerformance(platformVideoId, opts = {}) {
  const videoId = extractVideoId(platformVideoId);
  if (!videoId) throw new Error('Invalid YouTube video id');

  const { fetchPerVideoAnalytics } = require('../../services/channel_analytics');
  const channelId = opts.channelId || process.env.YOUTUBE_CHANNEL_ID;
  if (!channelId) throw new Error('YOUTUBE_CHANNEL_ID not set');

  const report = await fetchPerVideoAnalytics(channelId, {
    days: opts.days || 28,
    startDate: opts.startDate,
    endDate: opts.endDate,
  });

  const row = (report?.videos || []).find((r) => r.videoId === videoId);
  if (!row) {
    return {
      ok: false,
      videoId,
      reason: 'no_analytics_row',
      performance: null,
    };
  }

  const performance = {
    views: Number(row.views || 0),
    estimatedMinutesWatched: Number(row.estimatedMinutesWatched || 0),
    averageViewDuration: Number(row.averageViewDuration || 0),
    averageViewPercentage: Number(row.averageViewPercentage || 0),
    subscribersGained: Number(row.subscribersGained || 0),
    likes: Number(row.likes || 0),
    comments: Number(row.comments || 0),
    shares: Number(row.shares || 0),
    syncedAt: Date.now(),
  };

  const updated = memory.upsertVideo({
    platform: 'youtube',
    platformVideoId: videoId,
    performance,
    syncedAt: Date.now(),
  });

  return { ok: true, videoId, performance, video: updated };
}

async function syncAllKnownVideos(opts = {}) {
  const videos = memory.listVideos({ limit: opts.limit || 100 })
    .filter((v) => v.platform === 'youtube');
  if (!videos.length) return [];

  const { fetchPerVideoAnalytics } = require('../../services/channel_analytics');
  const channelId = opts.channelId || process.env.YOUTUBE_CHANNEL_ID;
  if (!channelId) throw new Error('YOUTUBE_CHANNEL_ID not set');

  // One Analytics API report covers every video — avoid a full fetch per video.
  const report = await fetchPerVideoAnalytics(channelId, {
    days: opts.days || 28,
    startDate: opts.startDate,
    endDate: opts.endDate,
  });
  const byId = new Map((report?.videos || []).map((r) => [r.videoId, r]));

  const results = [];
  for (const v of videos) {
    const videoId = extractVideoId(v.platformVideoId);
    const row = videoId ? byId.get(videoId) : null;
    if (!row) {
      // YouTube Analytics lags ~48-72h for fresh uploads — fall back to Data API live counts.
      const fallback = videoId ? await fetchDataApiFallback(videoId) : null;
      if (fallback) {
        memory.upsertVideo({
          platform: 'youtube',
          platformVideoId: videoId,
          performance: fallback,
          syncedAt: Date.now(),
        });
        results.push({ ok: true, videoId, performance: fallback, source: 'data_api' });
      } else {
        results.push({ ok: false, videoId: v.platformVideoId, reason: 'no_analytics_row' });
      }
      continue;
    }
    const performance = {
      views: Number(row.views || 0),
      estimatedMinutesWatched: Number(row.estimatedMinutesWatched || 0),
      averageViewDuration: Number(row.averageViewDuration || 0),
      averageViewPercentage: Number(row.averageViewPercentage || 0),
      subscribersGained: Number(row.subscribersGained || 0),
      likes: Number(row.likes || 0),
      comments: Number(row.comments || 0),
      shares: Number(row.shares || 0),
      syncedAt: Date.now(),
    };
    memory.upsertVideo({
      platform: 'youtube',
      platformVideoId: videoId,
      performance,
      syncedAt: Date.now(),
    });
    results.push({ ok: true, videoId, performance });
  }
  return results;
}

module.exports = {
  extractVideoId,
  syncVideoPerformance,
  syncAllKnownVideos,
};
