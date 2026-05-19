'use strict';
/**
 * Kick.com API Client — CPD-275
 *
 * Fetches public channel data (VODs, clips) from Kick's public API.
 * No OAuth required for public channel endpoints.
 *
 * Normalized content shape returned by all methods:
 *   { id, title, thumbnailUrl, duration, publishedAt, url, viewCount, platform: 'kick' }
 *
 * Rate limits: undocumented — 1s backoff on HTTP 429.
 */

const axios = require('axios');

const BASE_URL = (process.env.KICK_API_BASE_URL || 'https://kick.com/api').replace(/\/$/, '');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Convert ISO8601 duration (PT2H3M45S) or seconds to total seconds.
 * Kick uses seconds as integer for VODs, may use ISO8601 for clips.
 */
function toSeconds(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const match = String(value).match(/(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
}

/**
 * Kick VOD API returns duration in milliseconds (not seconds).
 * Any value > 86400 (1 day in seconds) is almost certainly milliseconds.
 */
function vodDurationToSeconds(value) {
  const raw = toSeconds(value);
  return raw > 86400 ? Math.round(raw / 1000) : raw;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class KickClient {
  constructor(options = {}) {
    this.baseUrl   = options.baseUrl || BASE_URL;
    this.userAgent = options.userAgent || 'AuraFlux/1.0 (+https://auraflux.co)';
    this._http     = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'Accept':     'application/json',
        'User-Agent': this.userAgent,
      },
    });
  }

  /**
   * Execute a request with simple 429 backoff.
   * @private
   *
   * NOTE: kick.com/api/* is protected by Cloudflare and returns 403 from any
   * datacenter IP (Render, AWS, GCP, etc.) regardless of User-Agent or headers.
   * This is a platform-level block — not a client bug. When 403 is received,
   * we throw a structured KickUnavailableError so callers can surface a clear
   * user-facing message instead of a generic 500.
   */
  async _req(method, path, params = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this._http.request({ method, url: path, params });
        return res.data;
      } catch (err) {
        const status = err.response?.status;
        if (status === 403) {
          const e = new Error(
            'Kick API is unavailable from this server (Cloudflare blocks datacenter IPs). ' +
            'Kick clips/VODs cannot be listed server-side. ' +
            'Workaround: paste a direct Kick clip URL when submitting a job.'
          );
          e.code = 'KICK_CLOUDFLARE_BLOCKED';
          e.isKickUnavailable = true;
          throw e;
        }
        if (status === 429 && attempt < 2) {
          console.warn(`[KickClient] 429 on ${path} — waiting 1s (attempt ${attempt + 1})`);
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if (status === 404) return null;
        throw err;
      }
    }
    return null;
  }

  /**
   * Fetch channel info by slug (username).
   * Returns null if channel not found.
   */
  async getChannel(username) {
    const data = await this._req('GET', `/v1/channels/${encodeURIComponent(username.toLowerCase())}`);
    if (!data) return null;
    return {
      id:          data.id,
      slug:        data.slug,
      username:    data.slug,
      displayName: data.user?.username || data.slug,
      avatarUrl:   data.user?.profile_pic || null,
      isLive:      !!data.livestream,
      followersCount: data.followers_count || 0,
    };
  }

  /**
   * Fetch recent VODs for a channel.
   * Returns normalized content items.
   */
  async getVideos(username, limit = DEFAULT_LIMIT) {
    const cap  = Math.min(Math.max(1, limit), MAX_LIMIT);
    const slug = username.toLowerCase();
    // Kick v2 videos endpoint
    const data = await this._req('GET', `/v2/channels/${encodeURIComponent(slug)}/videos`, {
      page: 1, per_page: cap,
    });
    const items = data?.data || data?.videos || (Array.isArray(data) ? data : []);
    return items.slice(0, cap).map((v) => ({
      id:           String(v.id),
      title:        v.session_title || v.title || 'Untitled',
      thumbnailUrl: v.thumbnail?.src || v.thumbnail || null,
      duration:     vodDurationToSeconds(v.duration),
      publishedAt:  v.created_at || v.start_time || null,
      url:          `https://kick.com/video/${v.id}`,
      viewCount:    v.views || 0,
      platform:     'kick',
      contentType:  'vod',
    }));
  }

  /**
   * Fetch recent clips for a channel.
   * Returns normalized content items.
   */
  async getClips(username, limit = DEFAULT_LIMIT) {
    const cap  = Math.min(Math.max(1, limit), MAX_LIMIT);
    const slug = username.toLowerCase();
    const data = await this._req('GET', `/v1/channels/${encodeURIComponent(slug)}/clips`, {
      cursor: 0, sort: 'date',
    });
    const items = data?.data?.clips || data?.clips || (Array.isArray(data) ? data : []);
    return items.slice(0, cap).map((c) => ({
      id:           String(c.id),
      title:        c.title || 'Untitled clip',
      thumbnailUrl: c.thumbnail_url || null,
      duration:     toSeconds(c.duration),
      publishedAt:  c.created_at || null,
      url:          c.clip_url || `https://kick.com/clip/${c.id}`,
      viewCount:    c.views || c.view_count || 0,
      platform:     'kick',
      contentType:  'clip',
    }));
  }

  /**
   * Fetch both clips and VODs in a single call. Returns merged, sorted by date.
   * Used by the source library API route.
   */
  async getContent(username, limit = DEFAULT_LIMIT) {
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

module.exports = KickClient;
