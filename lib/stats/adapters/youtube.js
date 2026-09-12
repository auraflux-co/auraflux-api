'use strict';
/**
 * YouTube lite stats for Creator — brand OAuth only (not ops broadcast tokens).
 * Prefers Analytics API when scope present; otherwise Data API channel statistics.
 */

const axios = require('axios');
const { loadTokens, saveTokens } = require('../../services/token_store');
const { refreshAccessToken } = require('../../publish/adapters/youtube');

const YT_ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';
const YT_DATA = 'https://www.googleapis.com/youtube/v3';

function hasAnalyticsScope(scope) {
  const s = String(scope || '');
  return /yt-analytics\.readonly|youtube\.analytics/i.test(s);
}

async function resolveAccessToken(customerId, brandId) {
  const tokens = await loadTokens(customerId, brandId, 'youtube');
  if (!tokens?.accessToken) return null;

  let accessToken = tokens.accessToken;
  const expired = tokens.tokenExpiry && new Date(tokens.tokenExpiry) < new Date();
  if (expired && tokens.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(tokens.refreshToken);
      accessToken = refreshed.access_token;
      await saveTokens({
        customerId,
        brandId,
        platform: 'youtube',
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || tokens.refreshToken,
        tokenExpiry: refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
          : null,
        scope: tokens.scope,
        platformUserId: tokens.platformUserId,
        platformHandle: tokens.platformHandle,
        rawMeta: tokens.rawMeta,
      });
      tokens.accessToken = accessToken;
    } catch (_e) {
      /* use existing token */
    }
  }
  return { accessToken, tokens };
}

/**
 * Lite YouTube summary for a brand.
 * @returns {{ ok: boolean, available?: boolean, reason?: string, source?: string, summary?: object }}
 */
async function fetchYoutubeLiteSummary(customerId, brandId, { days = 28 } = {}) {
  if (!customerId || !brandId) {
    return { ok: false, available: false, reason: 'missing_brand_context' };
  }
  const resolved = await resolveAccessToken(customerId, brandId);
  if (!resolved) {
    return { ok: true, available: false, reason: 'youtube_not_connected' };
  }
  const { accessToken, tokens } = resolved;
  const channelId = tokens.platformUserId || null;

  // Try Analytics when scope allows
  if (hasAnalyticsScope(tokens.scope) && channelId) {
    try {
      const end = new Date().toISOString().slice(0, 10);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - Math.min(90, Math.max(1, days)));
      const start = startDate.toISOString().slice(0, 10);
      const res = await axios.get(YT_ANALYTICS, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          ids: `channel==${channelId}`,
          startDate: start,
          endDate: end,
          metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained',
        },
        timeout: 20_000,
      });
      const row = (res.data?.rows && res.data.rows[0]) || [];
      return {
        ok: true,
        available: true,
        source: 'youtube_analytics',
        handle: tokens.platformHandle || null,
        channelId,
        windowDays: days,
        summary: {
          views: Number(row[0]) || 0,
          estimatedMinutesWatched: Number(row[1]) || 0,
          averageViewDurationSec: Number(row[2]) || 0,
          subscribersGained: Number(row[3]) || 0,
        },
        note: 'Impressions and CTR are not available from YouTube Analytics for this view.',
      };
    } catch (err) {
      // Fall through to Data API
      if (err.response?.status !== 403 && err.response?.status !== 400) {
        return {
          ok: false,
          available: false,
          reason: 'youtube_analytics_failed',
          message: err.message,
        };
      }
    }
  }

  // Data API channel statistics (works with youtube.readonly / youtube scopes)
  try {
    const res = await axios.get(`${YT_DATA}/channels`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { part: 'snippet,statistics', mine: true },
      timeout: 15_000,
    });
    const ch = res.data?.items?.[0];
    if (!ch) {
      return { ok: true, available: false, reason: 'no_channel', source: 'youtube_data' };
    }
    const stats = ch.statistics || {};
    return {
      ok: true,
      available: true,
      source: 'youtube_data',
      handle: tokens.platformHandle || ch.snippet?.customUrl || ch.snippet?.title || null,
      channelId: ch.id,
      summary: {
        views: Number(stats.viewCount) || 0,
        subscribers: Number(stats.subscriberCount) || 0,
        videoCount: Number(stats.videoCount) || 0,
      },
      note: hasAnalyticsScope(tokens.scope)
        ? null
        : 'Lifetime totals from YouTube Data API. Connect with Analytics scope for date-window metrics.',
    };
  } catch (err) {
    return {
      ok: false,
      available: false,
      reason: 'youtube_data_failed',
      message: err.message,
    };
  }
}

module.exports = {
  fetchYoutubeLiteSummary,
  hasAnalyticsScope,
};
