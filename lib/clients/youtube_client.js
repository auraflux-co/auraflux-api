'use strict';
/**
 * YouTube Data API v3 Client — CPD-276
 *
 * Fetches public channel videos and Shorts by handle or channelId.
 * Requires YOUTUBE_API_KEY env var.
 *
 * Free quota: 10,000 units/day.
 *   - channels.list by handle: 1 unit
 *   - search.list:             100 units
 *   - videos.list:             1 unit per video
 *
 * Normalized content shape:
 *   { id, title, thumbnailUrl, duration, publishedAt, url, viewCount, isShort, platform: 'youtube' }
 *
 * Setup:
 *   1. console.cloud.google.com → enable YouTube Data API v3
 *   2. Credentials → API key → restrict to YouTube Data API v3
 *   3. Set YOUTUBE_API_KEY in Render env vars + .env.local
 */

const axios = require('axios');

const YT_BASE = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Parse ISO8601 duration (PT4M13S) into total seconds.
 */
function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

/**
 * A Short is <= 60 seconds (ISO 8601 <= PT1M or PT<60S).
 * YouTube doesn't expose an explicit Shorts flag in the v3 API.
 */
function detectShort(durationIso) {
  return parseDuration(durationIso) <= 60;
}

class YouTubeClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.YOUTUBE_API_KEY;
    if (!this.apiKey) {
      console.warn('[YouTubeClient] YOUTUBE_API_KEY not set — channel lookups will fail');
    }
    // Send Referer header so HTTP-referrer-restricted API keys accept server-side calls
    this._http = axios.create({
      baseURL: YT_BASE,
      timeout: 15000,
      headers: { Referer: 'https://auraflux-api.onrender.com/' },
    });
    this._quotaUsed = 0;
  }

  _params(extra = {}) {
    return { key: this.apiKey, ...extra };
  }

  _logQuota(operation, cost) {
    this._quotaUsed += cost;
    console.log(`[YouTubeClient] ${operation} (${cost} units) — session total: ${this._quotaUsed}`);
  }

  /**
   * Resolve a YouTube @handle or channel username to a channelId.
   * Cost: 1 quota unit.
   */
  async getChannelByHandle(handle) {
    if (!this.apiKey) throw new Error('YOUTUBE_API_KEY not configured');
    const cleanHandle = handle.replace(/^@/, '');
    // Try forHandle first (requires v3 handle resolution)
    try {
      const res = await this._http.get('/channels', {
        params: this._params({ part: 'id,snippet', forHandle: cleanHandle }),
      });
      this._logQuota('channels.list forHandle', 1);
      const channel = res.data?.items?.[0];
      if (channel) {
        return {
          id:          channel.id,
          title:       channel.snippet?.title,
          description: channel.snippet?.description,
          thumbnailUrl: channel.snippet?.thumbnails?.default?.url || null,
          customUrl:   channel.snippet?.customUrl || null,
        };
      }
    } catch { /* fall through */ }

    // Fallback: search for channel by name
    const res = await this._http.get('/search', {
      params: this._params({ part: 'snippet', type: 'channel', q: cleanHandle, maxResults: 1 }),
    });
    this._logQuota('search.list channel fallback', 100);
    const item = res.data?.items?.[0];
    if (!item) return null;
    return {
      id:          item.snippet.channelId,
      title:       item.snippet.channelTitle,
      description: item.snippet.description,
      thumbnailUrl: item.snippet.thumbnails?.default?.url || null,
      customUrl:   null,
    };
  }

  /**
   * Fetch recent uploads for a channelId.
   * Cost: ~100 units per call (search.list) + 1/video (videos.list for duration).
   */
  async getRecentVideos(channelId, limit = DEFAULT_LIMIT) {
    if (!this.apiKey) throw new Error('YOUTUBE_API_KEY not configured');
    const cap = Math.min(Math.max(1, limit), MAX_LIMIT);

    const searchRes = await this._http.get('/search', {
      params: this._params({
        part: 'snippet',
        channelId,
        type: 'video',
        order: 'date',
        maxResults: cap,
      }),
    });
    this._logQuota('search.list videos', 100);

    const items = searchRes.data?.items || [];
    if (!items.length) return [];

    const videoIds = items.map((i) => i.id?.videoId).filter(Boolean);
    const detailRes = await this._http.get('/videos', {
      params: this._params({
        part: 'contentDetails,statistics',
        id: videoIds.join(','),
      }),
    });
    this._logQuota('videos.list details', videoIds.length);

    const detailMap = {};
    for (const v of detailRes.data?.items || []) {
      detailMap[v.id] = v;
    }

    return items.map((item) => {
      const vid    = item.id?.videoId;
      const detail = detailMap[vid];
      const durIso = detail?.contentDetails?.duration || null;
      return {
        id:           vid,
        title:        item.snippet?.title || 'Untitled',
        thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
        duration:     parseDuration(durIso),
        publishedAt:  item.snippet?.publishedAt || null,
        url:          `https://www.youtube.com/watch?v=${vid}`,
        viewCount:    parseInt(detail?.statistics?.viewCount || 0),
        isShort:      detectShort(durIso),
        platform:     'youtube',
      };
    });
  }

  /**
   * Fetch recent Shorts (videos <= 60s) for a channel.
   * Fetches recent videos and filters by duration.
   */
  async getShorts(channelId, limit = DEFAULT_LIMIT) {
    // Fetch more than requested to find enough Shorts after duration filter
    const videos = await this.getRecentVideos(channelId, Math.min(limit * 3, MAX_LIMIT));
    return videos.filter((v) => v.isShort).slice(0, limit);
  }

  /**
   * Fetch all content (videos + Shorts deduplicated) sorted by date.
   * Used by the source library API route.
   */
  async getContent(channelId, limit = DEFAULT_LIMIT) {
    const videos = await this.getRecentVideos(channelId, Math.min(limit, MAX_LIMIT));
    // videos already includes Shorts — return sorted by date
    return videos.slice(0, limit);
  }
}

module.exports = YouTubeClient;
