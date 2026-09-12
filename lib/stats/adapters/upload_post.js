'use strict';
/**
 * Upload-Post analytics adapter — profile rollup + per-post metrics.
 */

const axios = require('axios');

const UP_BASE = 'https://api.upload-post.com';

function headers() {
  const key = process.env.UPLOADPOST_API_KEY;
  if (!key) throw new Error('UPLOADPOST_API_KEY is not set');
  return { Authorization: `Apikey ${key}`, 'Content-Type': 'application/json' };
}

/**
 * Aggregated analytics for a brand Upload-Post profile.
 * @param {string} brandId — UP username
 * @param {string[]} [platforms]
 */
async function fetchProfileAnalytics(brandId, platforms = ['youtube', 'tiktok', 'instagram']) {
  if (!process.env.UPLOADPOST_API_KEY) {
    return { ok: false, reason: 'uploadpost_api_key_missing', platforms: {} };
  }
  try {
    const res = await axios.get(`${UP_BASE}/api/analytics/${encodeURIComponent(brandId)}`, {
      headers: headers(),
      params: { platforms: platforms.join(',') },
      timeout: 25_000,
      validateStatus: (s) => s < 500,
    });
    if (res.status === 404) {
      return { ok: false, reason: 'profile_not_found', platforms: {} };
    }
    if (res.status >= 400) {
      return {
        ok: false,
        reason: 'uploadpost_error',
        message: res.data?.error || res.data?.message || `HTTP ${res.status}`,
        platforms: {},
      };
    }
    const normalized = normalizeProfilePayload(res.data, platforms);
    return { ok: true, platforms: normalized, raw: res.data };
  } catch (err) {
    return {
      ok: false,
      reason: 'uploadpost_fetch_failed',
      message: err.message,
      platforms: {},
    };
  }
}

function normalizeProfilePayload(raw, platforms) {
  const out = {};
  const src = raw?.platforms || raw?.analytics || raw || {};
  const bag = typeof src === 'object' ? src : {};
  for (const p of platforms) {
    const block = bag[p] || bag[p?.toLowerCase?.()] || null;
    if (!block || typeof block !== 'object') {
      out[p] = null;
      continue;
    }
    out[p] = {
      followers: num(block.followers ?? block.follower_count ?? block.subscribers),
      views: num(block.views ?? block.view_count ?? block.video_views),
      impressions: num(block.impressions ?? block.reach),
      likes: num(block.likes ?? block.like_count),
      comments: num(block.comments ?? block.comment_count),
      shares: num(block.shares ?? block.share_count),
    };
  }
  return out;
}

/**
 * Per-post metrics by Upload-Post request_id.
 * @param {string} requestId
 */
async function fetchPostAnalytics(requestId) {
  if (!process.env.UPLOADPOST_API_KEY || !requestId) {
    return { ok: false, reason: !requestId ? 'missing_request_id' : 'uploadpost_api_key_missing' };
  }
  try {
    const res = await axios.get(`${UP_BASE}/api/uploadposts/analytics`, {
      headers: headers(),
      params: { request_id: requestId },
      timeout: 25_000,
      validateStatus: (s) => s < 500,
    });
    if (res.status === 404) return { ok: false, reason: 'not_found', requestId };
    if (res.status >= 400) {
      // Alternate path used by some UP API versions
      const alt = await axios.get(`${UP_BASE}/api/analytics/post`, {
        headers: headers(),
        params: { request_id: requestId },
        timeout: 25_000,
        validateStatus: (s) => s < 500,
      }).catch(() => null);
      if (alt && alt.status < 400) {
        return { ok: true, requestId, metrics: normalizePostMetrics(alt.data), raw: alt.data };
      }
      return {
        ok: false,
        reason: 'uploadpost_error',
        message: res.data?.error || res.data?.message || `HTTP ${res.status}`,
        requestId,
      };
    }
    return { ok: true, requestId, metrics: normalizePostMetrics(res.data), raw: res.data };
  } catch (err) {
    return { ok: false, reason: 'uploadpost_fetch_failed', message: err.message, requestId };
  }
}

function normalizePostMetrics(data) {
  const pm = data?.post_metrics || data?.metrics || data?.platforms || data || {};
  const out = {};
  if (pm && typeof pm === 'object' && !Array.isArray(pm)) {
    for (const [platform, block] of Object.entries(pm)) {
      if (!block || typeof block !== 'object') continue;
      if (['request_id', 'status', 'ok', 'error'].includes(platform)) continue;
      out[platform] = {
        views: num(block.views ?? block.view_count ?? block.video_views),
        impressions: num(block.impressions ?? block.reach),
        likes: num(block.likes ?? block.like_count),
        comments: num(block.comments ?? block.comment_count),
        shares: num(block.shares ?? block.share_count),
        reach: num(block.reach),
        averageWatchSec: num(block.average_time_watched ?? block.averageViewDuration),
      };
    }
  }
  return out;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  fetchProfileAnalytics,
  fetchPostAnalytics,
};
