'use strict';
/**
 * CPD-1192 — YouTube analytics adapter (wraps existing channel_analytics + hourly).
 */

const {
  fetchPerVideoAnalytics,
  fetchChannelSummary: fetchYtChannelSummary,
  hasAnalyticsScope,
} = require('../../services/channel_analytics');

const {
  fetchHourlyWatch,
  aggregateByHour,
  recommendGridWindow,
} = require('../../live_grid/hourly_analytics');

async function fetchVideoMetrics(channelId, opts = {}) {
  return fetchPerVideoAnalytics(channelId, opts);
}

async function fetchChannelSummary(channelId, opts = {}) {
  return fetchYtChannelSummary(channelId, opts);
}

async function fetchHourlyAnalytics(channelId, opts = {}) {
  const rows = await fetchHourlyWatch(channelId, opts);
  const byHour = aggregateByHour(rows);
  const recommendation = recommendGridWindow(byHour);
  return { rows, byHour, recommendation };
}

function analyticsReady() {
  return hasAnalyticsScope();
}

module.exports = {
  fetchVideoMetrics,
  fetchChannelSummary,
  fetchHourlyAnalytics,
  analyticsReady,
};
