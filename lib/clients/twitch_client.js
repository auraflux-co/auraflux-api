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
    this.requestWindow = this.requestWindow.filter((ts) => ts > oneMinuteAgo);

    if (this.requestWindow.length >= this.maxRequestsPerMinute) {
      const oldestRequest = this.requestWindow[0];
      const waitMs = oldestRequest + 60000 - now;

      if (waitMs > 0) {
        console.log(`[TwitchClient] Rate limit reached, waiting ${waitMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
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
    const match = urlOrSlug.match(
      /(?:clips\.twitch\.tv\/|twitch\.tv\/clips\/|twitch\.tv\/[^/]+\/clip\/)([^?&/]+)/
    );
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

    const gqlBody = [
      {
        operationName: 'VideoAccessToken_Clip',
        variables: { slug },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: '36b89d2507fce29e5ca551df756d27c1cfe079e2609642b4390aa4c35796eb11',
          },
        },
      },
    ];

    return withRetry(
      async () => {
        const resp = await axios.post('https://gql.twitch.tv/gql', gqlBody, {
          headers: {
            'Client-ID': this.gqlClientId,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        });

        const clip = resp.data?.[0]?.data?.clip;
        if (!clip) throw new Error('Clip not found in GQL response');

        const token = clip.playbackAccessToken;
        const qualities = clip.videoQualities || [];
        if (!qualities.length) throw new Error('No video qualities returned');

        // Select quality based on preference
        let best;
        if (preferQuality === 'low') {
          best =
            qualities.find((q) => q.quality === '720') ||
            qualities.find((q) => q.quality === '480') ||
            qualities.find((q) => q.quality === '360') ||
            qualities[qualities.length - 1];
        } else {
          best =
            qualities.find((q) => q.quality === '1080') ||
            qualities.find((q) => q.quality === '720') ||
            qualities[0];
        }

        const baseUrl = best.sourceURL;
        const mp4Url = `${baseUrl}?sig=${encodeURIComponent(token.signature)}&token=${encodeURIComponent(token.value)}`;

        return {
          mp4Url,
          quality: best.quality + 'p',
          frameRate: best.frameRate,
        };
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
    return thumbnailUrl.replace(/-preview-\d+x\d+\.jpg$/, '.mp4');
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
        const resp = await axios.get(`https://api.twitch.tv/helix/users?login=${login}`, {
          headers: {
            'Client-Id': this.clientId,
            Authorization: `Bearer ${this.token}`,
          },
          timeout: 10000,
        });

        const user = resp.data?.data?.[0];
        if (!user) throw new Error(`User not found: ${login}`);

        return user;
      },
      {
        label: 'TWITCH_HELIX_USER',
        retries: this.maxRetries,
        baseMs: 1000,
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

    // CPD-292: Helix clips sort by view count by default, returning old viral clips
    // that may have been deleted. Filter to clips from the last 90 days to ensure
    // availability. 90 days is wide enough to find clips for active streamers.
    const startedAt = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    return withRetry(
      async () => {
        const resp = await axios.get(
          `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&first=${Math.min(count, 100)}&started_at=${startedAt}`,
          {
            headers: {
              'Client-Id': this.clientId,
              Authorization: `Bearer ${this.token}`,
            },
            timeout: 10000,
          }
        );

        return resp.data?.data || [];
      },
      {
        label: 'TWITCH_HELIX_CLIPS',
        retries: this.maxRetries,
        baseMs: 1000,
      }
    );
  }

  /**
   * Extract video ID from a Twitch VOD URL or bare ID
   * @param {string} urlOrId - e.g. 'https://www.twitch.tv/videos/2770350206' or '2770350206'
   * @returns {string} Video ID
   */
  extractVideoId(urlOrId) {
    if (!urlOrId) return '';
    const match = String(urlOrId).match(/twitch\.tv\/videos\/(\d+)/);
    if (match) return match[1];
    if (/^\d+$/.test(String(urlOrId))) return String(urlOrId);
    return '';
  }

  /**
   * Get recent VODs (archives) for a broadcaster
   * @param {string} userId - Broadcaster user ID
   * @param {number} count - Number of VODs to fetch (max 100)
   * @param {'archive'|'highlight'|'upload'} type - VOD type (default 'archive')
   * @returns {Promise<Array>} VOD data from Helix API
   */
  async getVideos(userId, count = 5, type = 'archive') {
    if (!this.clientId || !this.token) {
      throw new Error('Twitch Client ID and Token required for Helix API');
    }

    await this.checkRateLimit();

    return withRetry(
      async () => {
        const resp = await axios.get(
          `https://api.twitch.tv/helix/videos?user_id=${userId}&first=${Math.min(count, 100)}&type=${type}`,
          {
            headers: {
              'Client-Id': this.clientId,
              Authorization: `Bearer ${this.token}`,
            },
            timeout: 10000,
          }
        );

        return resp.data?.data || [];
      },
      {
        label: 'TWITCH_HELIX_VIDEOS',
        retries: this.maxRetries,
        baseMs: 1000,
      }
    );
  }

  /**
   * Resolve a VOD ID to a signed HLS master playlist URL via GQL.
   * Uses usher.ttvnw.net (the active Twitch HLS delivery endpoint).
   *
   * @param {string} videoId - Twitch VOD ID (numeric string)
   * @param {'high'|'low'} preferQuality - 'high' returns source/1080p60, 'low' returns 480p
   * @returns {Promise<{
   *   hlsMasterUrl: string,
   *   hlsStreamUrl: string,
   *   resolution: string,
   *   frameRate: number,
   *   quality: string,
   *   streams: Array<{resolution, bandwidth, frameRate, url}>
   * }>}
   */
  async resolveVideoHls(videoId, preferQuality = 'high') {
    if (!videoId) throw new Error('No video ID provided');

    await this.checkRateLimit();

    const gqlBody = [
      {
        operationName: 'PlaybackAccessToken_Template',
        query:
          'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {' +
          ' streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }' +
          ' videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename }' +
          ' }',
        variables: {
          isLive: false,
          login: '',
          isVod: true,
          vodID: String(videoId),
          playerType: 'site',
        },
      },
    ];

    return withRetry(
      async () => {
        const resp = await axios.post('https://gql.twitch.tv/gql', gqlBody, {
          headers: {
            'Client-ID': this.gqlClientId,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        });

        const token = resp.data?.[0]?.data?.videoPlaybackAccessToken;
        if (!token) throw new Error('No video access token in GQL response');

        const p = Math.floor(Math.random() * 9000000 + 1000000);
        const hlsMasterUrl =
          `https://usher.ttvnw.net/vod/${videoId}.m3u8?` +
          `sig=${token.signature}` +
          `&token=${encodeURIComponent(token.value)}` +
          `&allow_source=true&allow_audio_only=true&allow_spectre=true` +
          `&platform=web&player=twitchweb&playlist_include_framerate=true&p=${p}`;

        const m3u8Resp = await axios.get(hlsMasterUrl, { timeout: 12000 });
        const m3u8 = String(m3u8Resp.data);
        if (!m3u8.includes('#EXTM3U')) throw new Error('Invalid M3U8 master playlist response');

        // Parse quality streams from master playlist
        const lines = m3u8.split('\n');
        const streams = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#EXT-X-STREAM-INF')) {
            const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1] || '';
            const bandwidth = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10);
            const frameRate = parseFloat(line.match(/FRAME-RATE=([\d.]+)/)?.[1] || '30');
            const url = lines[i + 1]?.trim();
            if (url && url.startsWith('http')) {
              streams.push({ resolution, bandwidth, frameRate, url });
            }
          }
        }

        if (!streams.length) throw new Error('No quality streams found in M3U8 master playlist');

        // Sort by bandwidth descending (highest = source quality)
        streams.sort((a, b) => b.bandwidth - a.bandwidth);

        const selected =
          preferQuality === 'low'
            ? streams[streams.length - 1]
            : streams[0];

        return {
          hlsMasterUrl,
          hlsStreamUrl: selected.url,
          resolution: selected.resolution,
          frameRate: selected.frameRate,
          quality: selected.resolution || 'source',
          streams,
        };
      },
      {
        label: 'TWITCH_VOD_HLS',
        retries: this.maxRetries,
        baseMs: 2000,
        onRetry: (attempt, err) => {
          console.log(`[TwitchClient] VOD HLS retry ${attempt}/${this.maxRetries}: ${err.message}`);
        },
      }
    );
  }

  /**
   * Validate token is still active
   * @returns {Promise<boolean>}
   */
  async validateToken() {
    if (!this.token) return false;

    try {
      const resp = await axios.get('https://id.twitch.tv/oauth2/validate', {
        headers: { Authorization: `OAuth ${this.token}` },
        timeout: 5000,
      });
      return resp.status === 200;
    } catch (err) {
      logError('TWITCH_TOKEN_VALIDATION', err);
      return false;
    }
  }
}

module.exports = TwitchClient;
