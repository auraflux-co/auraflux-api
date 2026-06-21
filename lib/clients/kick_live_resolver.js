'use strict';
/**
 * Kick live playback resolver (CPD-1065)
 *
 * Resolves a Kick channel slug → feed URL for live grid ingest.
 *
 * Metadata (live/offline, title, viewers):
 *   1. OAuth GET /public/v1/channels?slug= — when LIVE_GRID_KICK_OAUTH_CUSTOMER_ID + token
 *   2. kick_fetch.py v2 /api/v2/channels/{slug} — signed HLS + livestream
 *   3. Apify zhorex/kick-scraper — live metadata only
 *
 * Ingest URL when live:
 *   LIVE_GRID_KICK_INGEST=streamlink → https://kick.com/{slug} (streamlink handles tokens)
 *   default (hls) → signed playback_url from v2 API
 */

const path = require('path');
const { spawn } = require('child_process');
const { kickStreamlinkIngestEnabled, kickPageUrl } = require('../live_grid/kick_config');

const KICK_FETCH_PY = path.join(__dirname, 'kick_fetch.py');
const KICK_CHANNEL_API = 'https://kick.com/api/v2/channels';

/** @type {string|null|undefined} undefined = uncached; null = last fetch missed (retry allowed) */
let cachedApifyProxyPassword;
let cachedApifyProxyPasswordAt = 0;
const PROXY_PASSWORD_CACHE_MS = 60 * 60 * 1000;

function buildApifyProxyUrlFromPassword(proxyPassword) {
  if (!proxyPassword) return '';
  return `http://auto:${encodeURIComponent(proxyPassword)}@proxy.apify.com:8000`;
}

function buildApifyProxyUrl() {
  if (process.env.KICK_PROXY_URL) return process.env.KICK_PROXY_URL;
  return buildApifyProxyUrlFromPassword(process.env.APIFY_PROXY_PASSWORD);
}

/** Fetch Apify Proxy password (distinct from APIFY_API_TOKEN). Cached in-process. */
async function resolveApifyProxyPassword() {
  if (process.env.APIFY_PROXY_PASSWORD) return process.env.APIFY_PROXY_PASSWORD;
  const now = Date.now();
  if (
    cachedApifyProxyPassword
    && now - cachedApifyProxyPasswordAt < PROXY_PASSWORD_CACHE_MS
  ) {
    return cachedApifyProxyPassword;
  }

  const token = process.env.APIFY_API_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch('https://api.apify.com/v2/users/me', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Apify user API HTTP ${res.status}`);
    const body = await res.json();
    const pwd = body?.data?.proxy?.password || null;
    if (pwd) {
      cachedApifyProxyPassword = pwd;
      cachedApifyProxyPasswordAt = now;
    }
    return pwd;
  } catch {
    return null;
  }
}

async function resolveKickProxyUrl() {
  if (process.env.KICK_PROXY_URL) return process.env.KICK_PROXY_URL;
  const pwd = await resolveApifyProxyPassword();
  return buildApifyProxyUrlFromPassword(pwd);
}

function spawnKickFetch(url, params = {}) {
  return new Promise((resolve, reject) => {
    (async () => {
      const args = [KICK_FETCH_PY, url];
      if (Object.keys(params).length) args.push(JSON.stringify(params));
      const proxyUrl = await resolveKickProxyUrl();
      const env = { ...process.env };
      if (proxyUrl) env.KICK_PROXY_URL = proxyUrl;

      const proc = spawn('python3', args, { timeout: 25000, env });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', () => {
        if (!stdout.trim()) {
          return reject(new Error(`kick_fetch.py empty output: ${stderr.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error(`kick_fetch.py invalid JSON: ${stdout.slice(0, 200)}`));
        }
      });
      proc.on('error', reject);
    })().catch(reject);
  });
}

/** @returns {Promise<object|null>} Kick /api/v2/channels/{slug} body */
async function fetchKickChannelApi(slug) {
  const url = `${KICK_CHANNEL_API}/${encodeURIComponent(String(slug).toLowerCase())}`;
  const result = await spawnKickFetch(url);
  if (result.status === 404) return null;
  if (result.status !== 200) {
    throw new Error(result.error || `Kick API HTTP ${result.status}`);
  }
  return result.data || null;
}

function resolveKickOAuthCustomerId() {
  return process.env.LIVE_GRID_KICK_OAUTH_CUSTOMER_ID
    || process.env.BROADCAST_CUSTOMER_ID
    || process.env.PRODUCTION_CRON_CUSTOMER_ID
    || null;
}

/** Load first available Kick OAuth token for the configured broadcast customer. */
async function loadKickOAuthContext() {
  const customerId = resolveKickOAuthCustomerId();
  if (!customerId || !process.env.TOKEN_ENCRYPTION_KEY) return null;

  const tokenStore = require('../services/token_store');
  let tokens = await tokenStore.loadTokens(customerId, null, 'kick').catch(() => null);
  if (!tokens?.accessToken) {
    try {
      const db = require('../db');
      const res = await db.query(
        `SELECT brand_id FROM platform_oauth_tokens
          WHERE customer_id = $1 AND platform = 'kick'
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 1`,
        [customerId],
      );
      const brandId = res.rows[0]?.brand_id ?? null;
      if (brandId !== undefined) {
        tokens = await tokenStore.loadTokens(customerId, brandId, 'kick').catch(() => null);
      }
    } catch {
      return null;
    }
  }
  if (!tokens?.accessToken) return null;
  return { customerId, tokens };
}

/** OAuth channel metadata — no playback URL (official API does not expose M3U8). */
async function fetchKickChannelOAuth(slug) {
  const ctx = await loadKickOAuthContext();
  if (!ctx) return null;
  const KickUserApiClient = require('./kick_user_api');
  const client = new KickUserApiClient(ctx.tokens, ctx.customerId);
  try {
    const ch = await client.getChannel(slug);
    if (!ch) return null;
    const isLive = !!ch.stream?.is_live;
    return {
      slug: String(slug).toLowerCase(),
      isLive,
      playbackUrl: null,
      title: ch.stream_title || ch.stream?.title || null,
      viewers: ch.stream?.viewer_count || 0,
      source: 'kick_oauth',
      broadcasterUserId: ch.broadcaster_user_id || null,
    };
  } catch (err) {
    return {
      slug: String(slug).toLowerCase(),
      isLive: false,
      playbackUrl: null,
      title: null,
      viewers: 0,
      source: 'kick_oauth_error',
      error: err.message,
    };
  }
}

function withIngestUrl(result, slug) {
  const normalized = String(slug || result.slug || '').trim().toLowerCase();
  const ingestMode = kickStreamlinkIngestEnabled() ? 'streamlink' : 'hls';
  const pageUrl = kickPageUrl(normalized);
  if (result.isLive && ingestMode === 'streamlink' && pageUrl) {
    return {
      ...result,
      slug: normalized,
      playbackUrl: pageUrl,
      kickPageUrl: pageUrl,
      ingestMode,
    };
  }
  return { ...result, slug: normalized, ingestMode, kickPageUrl: pageUrl };
}

/**
 * Resolve live playback URL for a Kick channel.
 * @param {string} slug
 * @returns {Promise<{ slug: string, isLive: boolean, playbackUrl: string|null, title: string|null, viewers: number, source?: string, ingestMode?: string, kickPageUrl?: string }>}
 */
async function resolveKickLivePlayback(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) throw new Error('Kick slug required');

  if (kickStreamlinkIngestEnabled()) {
    const { kickChannelLive } = require('../live_grid/stream_probe');
    const isLive = await kickChannelLive(normalized);
    return withIngestUrl({
      slug: normalized,
      isLive,
      playbackUrl: isLive ? kickPageUrl(normalized) : null,
      title: null,
      viewers: 0,
      source: 'streamlink_probe',
    }, normalized);
  }

  const oauthMeta = await fetchKickChannelOAuth(normalized);
  if (oauthMeta?.isLive && kickStreamlinkIngestEnabled()) {
    return withIngestUrl(oauthMeta, normalized);
  }

  try {
    const data = await fetchKickChannelApi(normalized);
    if (data?.livestream && data.playback_url) {
      return withIngestUrl({
        slug: normalized,
        isLive: true,
        playbackUrl: data.playback_url,
        title: data.livestream.session_title || data.livestream.title || null,
        viewers: data.livestream.viewer_count || 0,
        source: 'kick_api',
      }, normalized);
    }
    if (data && !data.livestream) {
      if (oauthMeta?.isLive) {
        return withIngestUrl({ ...oauthMeta, source: oauthMeta.source || 'kick_oauth' }, normalized);
      }
      return withIngestUrl({
        slug: normalized, isLive: false, playbackUrl: null, title: null, viewers: 0, source: 'kick_api',
      }, normalized);
    }
  } catch (err) {
    if (oauthMeta) {
      if (oauthMeta.isLive) {
        return withIngestUrl(oauthMeta, normalized);
      }
      if (oauthMeta.source === 'kick_oauth') {
        return withIngestUrl(oauthMeta, normalized);
      }
    }
    if (process.env.APIFY_API_TOKEN) {
      const { fetchKickChannelDetails } = require('./kick_apify');
      const details = await fetchKickChannelDetails(normalized);
      const base = {
        slug: normalized,
        isLive: !!details?.isLive,
        playbackUrl: null,
        title: details?.currentStreamTitle || null,
        viewers: details?.currentViewers || 0,
        source: 'apify_metadata',
        error: err.message,
      };
      return withIngestUrl(base, normalized);
    }
    throw err;
  }

  if (oauthMeta?.isLive) {
    return withIngestUrl(oauthMeta, normalized);
  }

  if (process.env.APIFY_API_TOKEN) {
    const { fetchKickChannelDetails } = require('./kick_apify');
    const details = await fetchKickChannelDetails(normalized);
    return withIngestUrl({
      slug: normalized,
      isLive: !!details?.isLive,
      playbackUrl: null,
      title: details?.currentStreamTitle || null,
      viewers: details?.currentViewers || 0,
      source: 'apify_metadata',
    }, normalized);
  }

  if (oauthMeta) {
    return withIngestUrl(oauthMeta, normalized);
  }

  return withIngestUrl({
    slug: normalized, isLive: false, playbackUrl: null, title: null, viewers: 0, source: 'none',
  }, normalized);
}

function isKickPageUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.hostname.replace(/^www\./, '') === 'kick.com';
  } catch {
    return false;
  }
}

function isKickPlaybackUrl(url) {
  const s = String(url || '').toLowerCase();
  return s.includes('live-video.net') || /\.m3u8(\?|$)/.test(s);
}

function kickSlugFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[0] ? parts[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

module.exports = {
  resolveKickLivePlayback,
  fetchKickChannelApi,
  fetchKickChannelOAuth,
  loadKickOAuthContext,
  resolveKickOAuthCustomerId,
  buildApifyProxyUrl,
  resolveApifyProxyPassword,
  isKickPageUrl,
  isKickPlaybackUrl,
  kickSlugFromUrl,
};
