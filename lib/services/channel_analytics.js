'use strict';
/**
 * YouTube Analytics API — per-video metrics (requires OAuth + yt-analytics.readonly).
 *
 * NOT available via YouTube Data API (API key only gives public view counts).
 */

const axios = require('axios');
const { getAccessToken, loadTokens } = require('./youtube_direct');

const YT_ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';

function hasAnalyticsScope(tokens) {
  return !!(tokens?.scope || '').includes('yt-analytics.readonly');
}

/**
 * @param {string} channelId
 * @param {{ days?: number, startDate?: string, endDate?: string }} opts
 */
async function fetchAnalyticsReport(accessToken, params) {
  const res = await axios.get(YT_ANALYTICS, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
    timeout: 30_000,
  });
  return res.data;
}

function rowsToObjects(data) {
  const headers = data?.columnHeaders || [];
  const nameIdx = Object.fromEntries(headers.map((h, i) => [h.name, i]));
  return (data?.rows || []).map((row) => {
    const obj = {};
    for (const h of headers) obj[h.name] = row[nameIdx[h.name]];
    return obj;
  });
}

/**
 * Per-video metrics (views, retention, subs gained).
 * Note: impressions + CTR are NOT available with dimensions=video in YouTube Analytics v2 —
 * those require a separate channel-level or traffic-source query (see fetchChannelReachSummary).
 */
async function fetchPerVideoAnalytics(channelId, opts = {}) {
  const tokens = loadTokens();
  if (!hasAnalyticsScope(tokens)) {
    throw new Error('OAuth token missing yt-analytics.readonly scope');
  }

  const accessToken = await getAccessToken();
  const endDate = opts.endDate || new Date().toISOString().slice(0, 10);
  const startDate = opts.startDate || (() => {
    const d = new Date();
    d.setDate(d.getDate() - (opts.days || 90));
    return d.toISOString().slice(0, 10);
  })();

  const metrics = [
    'views',
    'engagedViews',
    'estimatedMinutesWatched',
    'averageViewDuration',
    'averageViewPercentage',
    'subscribersGained',
    'likes',
    'comments',
    'shares',
  ].join(',');

  const data = await fetchAnalyticsReport(accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics,
    dimensions: 'video',
    sort: '-views',
    maxResults: 200, // >200 returns 400 from YouTube Analytics API for dimensions=video
  });

  const rows = rowsToObjects(data);
  const videos = rows.map((row) => ({
    videoId: row.video,
    views: row.views ?? null,
    estimatedMinutesWatched: row.estimatedMinutesWatched ?? null,
    averageViewDuration: row.averageViewDuration ?? null,
    averageViewPercentage: row.averageViewPercentage ?? null,
    subscribersGained: row.subscribersGained ?? null,
    engagedViews: row.engagedViews ?? null,
    likes: row.likes ?? null,
    comments: row.comments ?? null,
    shares: row.shares ?? null,
  }));

  let channelSummary = null;
  try {
    channelSummary = await fetchChannelSummary(channelId, { startDate, endDate, accessToken });
  } catch { /* non-fatal */ }

  return {
    ok: true,
    channelId,
    startDate,
    endDate,
    videoCount: videos.length,
    videos,
    channelSummary,
    metricsNote:
      'YouTube Analytics API v2 does not expose impressions or impressionClickThroughRate for creator channels. ' +
      'Use Studio for reach/CTR, or Upload-Post for cross-platform aggregates. Per-video: views, retention, subs gained, engagedViews.',
  };
}

/** Channel-level rollup (no impressions — metric not available in Analytics API v2). */
async function fetchChannelSummary(channelId, opts = {}) {
  const accessToken = opts.accessToken || await getAccessToken();
  const endDate = opts.endDate || new Date().toISOString().slice(0, 10);
  const startDate = opts.startDate || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 28);
    return d.toISOString().slice(0, 10);
  })();

  const data = await fetchAnalyticsReport(accessToken, {
    ids: `channel==${channelId}`,
    startDate,
    endDate,
    metrics: 'views,engagedViews,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments,shares',
    dimensions: 'day',
    sort: 'day',
  });

  const rows = rowsToObjects(data);
  const totals = rows.reduce(
    (acc, r) => {
      for (const k of Object.keys(r)) {
        if (k === 'day') continue;
        acc[k] = (acc[k] || 0) + (r[k] || 0);
      }
      return acc;
    },
    {}
  );

  return { startDate, endDate, daily: rows, totals };
}

module.exports = {
  hasAnalyticsScope,
  fetchPerVideoAnalytics,
  fetchChannelSummary,
};
