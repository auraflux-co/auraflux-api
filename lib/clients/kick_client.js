'use strict';
/**
 * Kick.com API Client — CPD-275 / CPD-291 / CPD-316
 *
 * Fetches public channel data (VODs, clips) from Kick.
 *
 * Strategy (in priority order):
 *   1. Apify zhorex/kick-scraper actor (CPD-316) — used when APIFY_API_TOKEN is set.
 *      Apify runs on infra not blocked by Kick's Cloudflare policy. ~5s latency.
 *   2. kick_fetch.py TLS fingerprint bypass — direct Kick API via curl_cffi/tls_client.
 *      Falls back automatically if Apify token is absent. May fail from Render IPs.
 *
 * DO NOT use BrightData or Oxylabs proxies for Kick — both block streaming sites
 * at their network policy level. See CPD-316 for full history.
 *
 * Normalized content shape:
 *   { id, title, thumbnailUrl, duration, publishedAt, url, viewCount, platform: 'kick', contentType }
 */

const path   = require('path');
const { spawn } = require('child_process');

const KICK_FETCH_PY = path.join(__dirname, 'kick_fetch.py');
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
    this.baseUrl = options.baseUrl || BASE_URL;
  }

  /**
   * Invoke kick_fetch.py to make a Chrome-fingerprinted HTTPS request.
   * Returns parsed JSON response data, or null on 404.
   * @private
   */
  _fetchPy(url, params = {}) {
    return new Promise((resolve, reject) => {
      const args = [KICK_FETCH_PY, url];
      if (Object.keys(params).length > 0) args.push(JSON.stringify(params));

      const proc = spawn('python3', args, { timeout: 20000 });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', () => {
        if (!stdout.trim()) {
          return reject(new Error(`kick_fetch.py produced no output. stderr: ${stderr.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          reject(new Error(`kick_fetch.py output not JSON: ${stdout.slice(0, 200)}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Execute a GET request via the Python TLS-client proxy with 429 backoff.
   * @private
   */
  async _req(method, reqPath, params = {}) {
    const url = `${this.baseUrl}${reqPath}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let result;
      try {
        result = await this._fetchPy(url, params);
      } catch (err) {
        if (attempt < 2) { await sleep(1000); continue; }
        throw err;
      }

      const { status, data, error } = result;
      if (status === 200) return data;
      if (status === 403 || status === 503) {
        const e = new Error(
          error ||
          'Kick API is unavailable — Cloudflare blocked the request. ' +
          'Set KICK_PROXY_URL to a residential proxy to bypass.'
        );
        e.code = 'KICK_CLOUDFLARE_BLOCKED';
        e.isKickUnavailable = true;
        throw e;
      }
      if (status === 429 && attempt < 2) {
        console.warn(`[KickClient] 429 on ${reqPath} — waiting ${attempt + 1}s`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (status === 404) return null;
      throw new Error(`Kick API error ${status} on ${reqPath}: ${error}`);
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
    const data = await this._req('GET', `/v2/channels/${encodeURIComponent(slug)}/clips`, {
      sort: 'date', time: 'all', cursor: '', clip_type: 'clip',
    });
    const items = data?.clips || data?.data?.clips || (Array.isArray(data) ? data : []);
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
   *
   * Uses Apify actor (CPD-316) when APIFY_API_TOKEN is set; falls back to
   * direct kick_fetch.py TLS bypass otherwise.
   */
  async getContent(username, limit = DEFAULT_LIMIT, opts = {}) {
    // Apify path — preferred when token is configured
    if (process.env.APIFY_API_TOKEN) {
      try {
        const { fetchKickContent } = require('./kick_apify');
        const type = opts.type || 'all';
        return await fetchKickContent(username, type, limit);
      } catch (err) {
        // Surface Apify errors as KickUnavailable so the route returns the
        // correct 503 + workaround message rather than a bare 500.
        const e = new Error(`Kick via Apify failed: ${err.message}`);
        e.isKickUnavailable = true;
        throw e;
      }
    }

    // Direct fallback — TLS fingerprint bypass via kick_fetch.py
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

module.exports = KickClient;
