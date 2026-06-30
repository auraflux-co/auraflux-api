'use strict';
/**
 * CPD-1192 — Unified analytics facade (platform adapter pattern).
 * Selects adapter by platform; owns no platform-specific API calls.
 */

const ADAPTERS = {
  youtube: () => require('./adapters/youtube'),
};

function getAdapter(platform = 'youtube') {
  const factory = ADAPTERS[platform];
  if (!factory) throw new Error(`No analytics adapter registered for: ${platform}`);
  return factory();
}

async function fetchVideoMetrics(platform, channelId, opts = {}) {
  return getAdapter(platform).fetchVideoMetrics(channelId, opts);
}

async function fetchChannelSummary(platform, channelId, opts = {}) {
  return getAdapter(platform).fetchChannelSummary(channelId, opts);
}

async function fetchHourlyAnalytics(platform, channelId, opts = {}) {
  return getAdapter(platform).fetchHourlyAnalytics(channelId, opts);
}

function isAnalyticsReady(platform = 'youtube') {
  try {
    return getAdapter(platform).analyticsReady();
  } catch {
    return false;
  }
}

module.exports = {
  getAdapter,
  fetchVideoMetrics,
  fetchChannelSummary,
  fetchHourlyAnalytics,
  isAnalyticsReady,
};
