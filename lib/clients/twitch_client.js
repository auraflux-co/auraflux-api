/**
 * Twitch API Client
 * 
 * Handles all Twitch API interactions with:
 * - GQL API for clip MP4 resolution
 * - Helix API for user/clip metadata
 * - Token management and refresh
 * - Rate limiting
 * - Automatic retry logic
 */

const axios = require('axios');
const { logError, withRetry } = require('../error_logger');

/** Twitch GQL persisted-query hashes — rotate when clip resolve breaks (see yt-dlp twitch.py). */
const GQL_OPERATION_HASHES = {
  ShareClipRenderStatus: '0a02bb974443b576f5579aab0fef1d4b7f44e58a8a256f0c5adfead0db70640f',
  VideoAccessToken_Clip: '4f35f1ac933d76b1da008c806cd5546a7534dfaff83e033a422a81f24e5991b3',
};

function pickClipQuality(qualities, preferQuality) {
  if (!qualities?.length) return null;
  if (preferQuality === 'low') {
    return qualities.find(q => q.quality === '720')
      || qualities.find(q => q.quality === '480')
      || qualities.find(q => q.quality === '360')
      || qualities[qualities.length - 1];
  }
  return qualities.find(q => q.quality === '1080')
    || qualities.find(q => q.quality === '720')
    || qualities[0];
}

function signedClipMp4FromGqlClip(clip, preferQuality) {
  if (!clip) throw new Error('Clip not found in GQL response');
  const token = clip.playbackAccessToken;
  if (!token?.signature || !token?.value) throw new Error('No playback access token returned');

  const asset = clip.assets?.[0];
  const qualities = asset?.videoQualities || clip.videoQualities || [];
  const best = pickClipQuality(qualities, preferQuality);
  if (!best?.sourceURL) throw new Error('No video qualities returned');

  return {
    mp4Url: `${best.sourceURL}?sig=${encodeURIComponent(token.signature)}&token=${encodeURIComponent(token.value)}`,
    quality: String(best.quality).includes('p') ? best.quality : `${best.quality}p`,
    frameRate: best.frameRate,
  };
}

class TwitchClient {
  constructor(options = {}) {
    this.clientId = options.clientId || process.env.TWITCH_CLIENT_ID;
    this.token = options.token || process.env.TWITCH_TOKEN;
    this.gqlClientId = options.gqlClientId || 'kimne78kx3ncx6brgo4mv6wki5h1ko';
    this.maxRetries = options.maxRetries || 3;
    
    // Rate limiting: track requests per minute
    this.requestWindow = [];
    this.maxRequestsPerMinute = options.maxRequestsPerMinute || 800; // Twitch allows 800/min
  }

  /**
   * Check rate limit before making request
   * @private
   */
  async checkRateLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Remove old requests from window
    this.requestWindow = this.requestWindow.filter(ts => ts > oneMinuteAgo);
    
    if (this.requestWindow.length >= this.maxRequestsPerMinute) {
      const oldestRequest = this.requestWindow[0];
      const waitMs = oldestRequest + 60000 - now;
      
      if (waitMs > 0) {
        console.log(`[TwitchClient] Rate limit reached, waiting ${waitMs}ms`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
    
    this.requestWindow.push(now);
  }

  /**
   * Extract clip slug from various Twitch URL formats
   * @param {string} urlOrSlug - Twitch clip URL or bare slug
   * @returns {string} Clip slug
   */
  extractSlug(urlOrSlug) {
    if (!urlOrSlug) return '';
    
    // Handle: https://clips.twitch.tv/SomeSlug
    // Handle: https://www.twitch.tv/clips/SomeSlug
    // Handle: https://www.twitch.tv/channelname/clip/SomeSlug
    const match = urlOrSlug.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/clips\/|twitch\.tv\/[^/]+\/clip\/)([^?&/]+)/);
    if (match) return match[1];
    
    // Bare slug (no slashes, no protocol)
    if (!urlOrSlug.includes('/') && !urlOrSlug.includes(':')) return urlOrSlug;
    
    return '';
  }

  /**
   * Resolve clip slug to MP4 URL via GQL API
   * @param {string} slug - Clip slug
   * @param {string} preferQuality - 'low' (720p) or 'high' (1080p)
   * @returns {Promise<{ mp4Url: string, quality: string, frameRate: number }>}
   */
  async resolveClipMp4(slug, preferQuality = 'high') {
    if (!slug) throw new Error('No clip slug provided');

    await this.checkRateLimit();

    const postGql = async (operationName, variables) => {
      const hash = GQL_OPERATION_HASHES[operationName];
      if (!hash) throw new Error(`Unknown GQL operation: ${operationName}`);
      const gqlBody = [{
        operationName,
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      }];
      const resp = await axios.post('https://gql.twitch.tv/gql', gqlBody, {
        headers: {
          'Client-ID': this.gqlClientId,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
      const payload = resp.data?.[0];
      if (payload?.errors?.length) {
        throw new Error(payload.errors.map(e => e.message).join('; '));
      }
      return payload?.data?.clip;
    };

    return withRetry(
      async () => {
        try {
          const clip = await postGql('ShareClipRenderStatus', { slug });
          return signedClipMp4FromGqlClip(clip, preferQuality);
        } catch (primaryErr) {
          const clip = await postGql('VideoAccessToken_Clip', { slug, platform: 'web' });
          return signedClipMp4FromGqlClip(clip, preferQuality);
        }
      },
      {
        label: 'TWITCH_GQL',
        retries: this.maxRetries,
        baseMs: 2000,
        onRetry: (attempt, err) => {
          console.log(`[TwitchClient] GQL retry ${attempt}/${this.maxRetries}: ${err.message}`);
        },
      }
    );
  }

  /**
   * Derive MP4 URL from thumbnail URL (fallback method, lower quality)
   * @param {string} thumbnailUrl - Twitch thumbnail URL
   * @returns {string} MP4 URL
   */
  thumbnailToMp4(thumbnailUrl) {
    if (!thumbnailUrl) return '';
    // Legacy clips-media-assets2: .../clip-id-preview-480x272.jpg → .mp4
    const legacy = thumbnailUrl.replace(/-preview-\d+x\d+\.jpg$/i, '.mp4');
    if (legacy !== thumbnailUrl && legacy.endsWith('.mp4')) return legacy;
    // 2026+ VAP assets (static-cdn.jtvnw.net/.../thumb/thumb-*.jpg) — no stable public MP4;
    // callers fall back to clip page URL + yt-dlp at assembly time.
    return '';
  }

  /**
   * CPD-865: mint a fresh app access token via client_credentials when the
   * static TWITCH_TOKEN expires (~60 days) — a 401 used to block VOD jobs
   * until the token was manually re-minted.
   *
   * Helix requires the bearer token to belong to the same app as the Client-Id
   * header, so candidates are tried as (id, secret) PAIRS. process.env is
   * updated too so direct env readers (server.js status endpoints, OBS source)
   * pick up the fresh token without a restart.
   * @returns {Promise<boolean>} true if a new token was minted
   */
  async refreshAppToken() {
    const candidates = [
      { id: this.clientId || process.env.TWITCH_CLIENT_ID, secret: process.env.TWITCH_CLIENT_SECRET },
      { id: process.env.TWITCH_OAUTH_CLIENT_ID, secret: process.env.TWITCH_OAUTH_CLIENT_SECRET },
    ];
    for (const { id, secret } of candidates) {
      if (!id || !secret) continue;
      try {
        const resp = await axios.post(
          'https://id.twitch.tv/oauth2/token',
          new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        );
        const token = resp.data?.access_token;
        if (!token) continue;
        this.clientId = id;
        this.token = token;
        process.env.TWITCH_CLIENT_ID = id;
        process.env.TWITCH_TOKEN = token;
        const days = Math.round((resp.data.expires_in || 0) / 86400);
        console.log(`[TwitchClient] App token auto-refreshed (client ${String(id).slice(0, 6)}…, expires ~${days}d)`);
        return true;
      } catch (err) {
        logError('TWITCH_APP_TOKEN_REFRESH', err, { clientId: String(id).slice(0, 6) });
      }
    }
    return false;
  }

  /**
   * Helix GET with one automatic token refresh + retry on 401 (CPD-865).
   * @private
   */
  async _helixGet(url) {
    const doGet = () => axios.get(url, {
      headers: {
        'Client-Id': this.clientId,
        'Authorization': `Bearer ${this.token}`
      },
      timeout: 10000
    });
    try {
      return await doGet();
    } catch (err) {
      if (err.response?.status === 401 && await this.refreshAppToken()) {
        return doGet();
      }
      throw err;
    }
  }

  /**
   * Helix GET with shared rate window + 429 Retry-After backoff (picker / clip fetch).
   * @param {string} url
   * @param {string} label - log label
   */
  async helixGetWithRetry(url, label = 'TWITCH_HELIX') {
    if (!this.clientId || !this.token) {
      throw new Error('Twitch Client ID and Token required for Helix API');
    }
    return withRetry(
      async () => {
        await this.checkRateLimit();
        try {
          return await this._helixGet(url);
        } catch (err) {
          if (err.response?.status === 429) {
            const retryAfter = parseInt(err.response?.headers?.['retry-after'], 10);
            const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 2) * 1000;
            console.warn(`[TwitchClient] 429 ${label} — waiting ${waitMs}ms`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
          throw err;
        }
      },
      {
        label,
        retries: 5,
        baseMs: 1500,
        onRetry: (attempt, err) => {
          if (err.response?.status !== 429) {
            console.log(`[TwitchClient] ${label} retry ${attempt}/5: ${err.message}`);
          }
        },
      }
    );
  }

  /**
   * Get user info by login name
   * @param {string} login - Twitch username
   * @returns {Promise<Object>} User data
   */
  async getUserByLogin(login) {
    if (!this.clientId || !this.token) {
      throw new Error('Twitch Client ID and Token required for Helix API');
    }

    await this.checkRateLimit();

    return withRetry(
      async () => {
        const resp = await this._helixGet(`https://api.twitch.tv/helix/users?login=${login}`);

        const user = resp.data?.data?.[0];
        if (!user) throw new Error(`User not found: ${login}`);

        return user;
      },
      {
        label: 'TWITCH_HELIX_USER',
        retries: this.maxRetries,
        baseMs: 1000
      }
    );
  }

  /**
   * Get recent clips for a broadcaster
   * @param {string} broadcasterId - Broadcaster user ID
   * @param {number} count - Number of clips to fetch (max 100)
   * @returns {Promise<Array>} Clip data
   */
  async getClips(broadcasterId, count = 10) {
    if (!this.clientId || !this.token) {
      throw new Error('Twitch Client ID and Token required for Helix API');
    }

    await this.checkRateLimit();

    return withRetry(
      async () => {
        const resp = await this._helixGet(
          `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&first=${Math.min(count, 100)}`
        );

        return resp.data?.data || [];
      },
      {
        label: 'TWITCH_HELIX_CLIPS',
        retries: this.maxRetries,
        baseMs: 1000
      }
    );
  }

  /**
   * Fetch a single clip by id (slug) via Helix.
   * @param {string} clipId - Twitch clip id / URL slug
   * @returns {Promise<Object>} Helix clip object
   */
  async getClipById(clipId) {
    if (!this.clientId || !this.token) {
      throw new Error('Twitch Client ID and Token required for Helix API');
    }
    if (!clipId) throw new Error('No clip id provided');

    await this.checkRateLimit();

    return withRetry(
      async () => {
        const resp = await this._helixGet(
          `https://api.twitch.tv/helix/clips?id=${encodeURIComponent(clipId)}`
        );
        const clip = resp.data?.data?.[0];
        if (!clip) throw new Error(`Helix: clip not found: ${clipId}`);
        return clip;
      },
      {
        label: 'TWITCH_HELIX_CLIP',
        retries: this.maxRetries,
        baseMs: 1000
      }
    );
  }

  /**
   * Resolve clip page URL or slug to public Helix-derived CDN MP4 (CPD-349).
   * Uses thumbnailToMp4 — no GQL playback token required.
   * @param {string} urlOrSlug - Clip page URL or bare slug
   * @returns {Promise<string>} clips-media-assets2.twitch.tv MP4 URL
   */
  async resolveClipCdnFromHelix(urlOrSlug) {
    const slug = this.extractSlug(urlOrSlug) || urlOrSlug;
    if (!slug) throw new Error('No clip slug provided');
    const clip = await this.getClipById(slug);
    const mp4Url = this.thumbnailToMp4(clip.thumbnail_url);
    if (!mp4Url) throw new Error(`Helix: cannot derive CDN URL for clip ${slug}`);
    return mp4Url;
  }

  /**
   * Validate token is still active
   * @returns {Promise<boolean>}
   */
  async validateToken() {
    if (!this.token) return false;

    try {
      const resp = await axios.get('https://id.twitch.tv/oauth2/validate', {
        headers: { 'Authorization': `OAuth ${this.token}` },
        timeout: 5000
      });
      return resp.status === 200;
    } catch (err) {
      logError('TWITCH_TOKEN_VALIDATION', err);
      return false;
    }
  }
}

module.exports = TwitchClient;
module.exports.GQL_OPERATION_HASHES = GQL_OPERATION_HASHES;
module.exports.signedClipMp4FromGqlClip = signedClipMp4FromGqlClip;
