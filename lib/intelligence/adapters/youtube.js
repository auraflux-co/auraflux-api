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

async function syncVideoPerformance(platformVideoId, opts = {}) {
  const videoId = extractVideoId(platformVideoId);
  if (!videoId) throw new Error('Invalid YouTube video id');

  const { fetchPerVideoAnalytics } = require('../../services/channel_analytics');
  const channelId = opts.channelId || process.env.YOUTUBE_CHANNEL_ID;
  if (!channelId) throw new Error('YOUTUBE_CHANNEL_ID not set');

  const rows = await fetchPerVideoAnalytics(channelId, {
    days: opts.days || 28,
    startDate: opts.startDate,
    endDate: opts.endDate,
  });

  const row = rows.find((r) => r.video === videoId);
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
  const videos = memory.listVideos({ limit: opts.limit || 100 });
  const results = [];
  for (const v of videos) {
    if (v.platform !== 'youtube') continue;
    try {
      results.push(await syncVideoPerformance(v.platformVideoId, opts));
    } catch (e) {
      results.push({ ok: false, videoId: v.platformVideoId, error: e.message });
    }
  }
  return results;
}

module.exports = {
  extractVideoId,
  syncVideoPerformance,
  syncAllKnownVideos,
};
