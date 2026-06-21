'use strict';
/**
 * lib/clients/kick_user_api.js — Kick public API v1 client (OAuth bearer) (CPD-353)
 *
 * Uses the user's connected OAuth token to call api.kick.com/public/v1 directly,
 * bypassing Cloudflare and Apify entirely. Preferred strategy when a token is available.
 *
 * Endpoints used:
 *   GET /public/v1/channels/{slug}/clips  — requires channel:read scope
 *   GET /public/v1/channels/{slug}/videos — requires channel:read scope
 */

const fetch       = require('node-fetch');
const tokenStore  = require('../services/token_store');
const kickOAuth   = require('../publish/adapters/kick_oauth');

const API_BASE    = 'https://api.kick.com/public/v1';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;

function toSeconds(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const match = String(value).match(/(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
}

/**
 * Make a GET request to Kick public API v1 with automatic token refresh.
 *
 * @param {string} path          — e.g. '/channels/username/clips'
 * @param {object} storedTokens  — { accessToken, refreshToken, ... } from token_store
 * @param {string} customerId    — used to persist refreshed token
 * @returns {Promise<object>}    — parsed JSON body
 */
async function _get(path, storedTokens, customerId) {
  let { accessToken, refreshToken } = storedTokens;

  const doFetch = async (token) => {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    return res;
  };

  let res = await doFetch(accessToken);

  // Attempt a single token refresh on 401
  if (res.status === 401 && refreshToken) {
    try {
      const refreshed = await kickOAuth.refreshAccessToken(refreshToken);
      const newExpiry = refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        : null;
      await tokenStore.saveTokens({
        customerId,
        platform:     'kick',
        accessToken:  refreshed.access_token,
        refreshToken: refreshed.refresh_token || refreshToken,
        tokenExpiry:  newExpiry,
        scope:        refreshed.scope || storedTokens.scope,
        platformUserId: storedTokens.platformUserId,
        platformHandle: storedTokens.platformHandle,
      });
      accessToken = refreshed.access_token;
      res = await doFetch(accessToken);
    } catch (err) {
      const e = new Error(`Kick token refresh failed: ${err.message}`);
      e.isKickTokenExpired = true;
      throw e;
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kick API ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Normalise a Kick public-API clip object to the shared content shape.
 */
function normaliseClip(c) {
  return {
    id:           String(c.id),
    title:        c.title || 'Untitled clip',
    thumbnailUrl: c.thumbnail_url || null,
    duration:     toSeconds(c.duration),
    publishedAt:  c.created_at || null,
    url:          c.clip_url || `https://kick.com/clip/${c.id}`,
    viewCount:    c.view_count || c.views || 0,
    platform:     'kick',
    contentType:  'clip',
  };
}

/**
 * Normalise a Kick public-API video (VOD) object to the shared content shape.
 */
function normaliseVideo(v) {
  return {
    id:           String(v.id),
    title:        v.session_title || v.title || 'Untitled',
    thumbnailUrl: v.thumbnail?.src || v.thumbnail || null,
    duration:     toSeconds(v.duration),
    publishedAt:  v.created_at || v.start_time || null,
    url:          `https://kick.com/video/${v.id}`,
    viewCount:    v.views || v.view_count || 0,
    platform:     'kick',
    contentType:  'vod',
  };
}

class KickUserApiClient {
  /**
   * @param {object} storedTokens — from token_store.loadTokens
   * @param {string} customerId
   */
  constructor(storedTokens, customerId) {
    this.tokens     = storedTokens;
    this.customerId = customerId;
  }

  async getClips(username, limit = DEFAULT_LIMIT) {
    const cap  = Math.min(Math.max(1, limit), MAX_LIMIT);
    const slug = username.toLowerCase();
    const body = await _get(`/channels/${encodeURIComponent(slug)}/clips`, this.tokens, this.customerId);
    const items = body?.data || (Array.isArray(body) ? body : []);
    return items.slice(0, cap).map(normaliseClip);
  }

  async getVideos(username, limit = DEFAULT_LIMIT) {
    const cap  = Math.min(Math.max(1, limit), MAX_LIMIT);
    const slug = username.toLowerCase();
    const body = await _get(`/channels/${encodeURIComponent(slug)}/videos`, this.tokens, this.customerId);
    const items = body?.data || (Array.isArray(body) ? body : []);
    return items.slice(0, cap).map(normaliseVideo);
  }

  /** Channel metadata including stream.is_live (OAuth public API v1). */
  async getChannel(slug) {
    const s = String(slug || '').trim().toLowerCase();
    if (!s) throw new Error('Kick slug required');
    const body = await _get(`/channels?slug=${encodeURIComponent(s)}`, this.tokens, this.customerId);
    const items = body?.data || (Array.isArray(body) ? body : []);
    return items[0] || null;
  }

  async getContent(username, limit = DEFAULT_LIMIT, opts = {}) {
    const type = opts.type || 'all';
    if (type === 'clip') return this.getClips(username, limit);
    if (type === 'vod')  return this.getVideos(username, limit);

    const half = Math.ceil(limit / 2);
    const [clips, videos] = await Promise.allSettled([
      this.getClips(username, half),
      this.getVideos(username, half),
    ]);
    const clipItems  = clips.status  === 'fulfilled' ? clips.value  : [];
    const videoItems = videos.status === 'fulfilled' ? videos.value : [];
    return [...clipItems, ...videoItems]
      .sort((a, b) => (b.publishedAt || '') > (a.publishedAt || '') ? 1 : -1)
      .slice(0, limit);
  }
}

module.exports = KickUserApiClient;
