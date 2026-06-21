'use strict';
/**
 * lib/publish/adapters/youtube.js — YouTube Data API v3 direct upload (CPD-33)
 *
 * Contract (from lib/publish/index.js):
 *   publish({ videoPath, metadata, jobSpec, tokens }) → { platformJobId, url, status }
 *
 * OAuth scopes required: https://www.googleapis.com/auth/youtube.upload
 * Quota cost: ~1,600 units per video upload + 50 per thumbnail set
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { trackYouTubeQuota, assertYouTubeQuota } = require('../../services/token_store');
const { appendSupportPromoToDescription } = require('../../clipzworld_support');

const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_UNITS = 1600;
const THUMB_UNITS = 50;

/**
 * Refresh a YouTube access token using the refresh token.
 * @param {string} refreshToken
 * @returns {object} { access_token, expires_in }
 */
async function refreshAccessToken(refreshToken) {
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return res.data;
}

/**
 * Upload a video to YouTube via resumable upload.
 *
 * @param {object} p
 * @param {string} p.videoPath    — local file path or Google Drive URL
 * @param {object} p.metadata     — { title, description, tags, categoryId, privacyStatus, publishAt }
 * @param {string} p.accessToken
 * @param {string} p.customerId   — for quota tracking
 * @param {string} [p.thumbnailPath]
 * @returns {object} { videoId, url, status }
 */
async function publish({ videoPath, metadata, tokens, jobSpec }) {
  const customerId = jobSpec?.customerId;
  const brandId = jobSpec?.brandId;

  // Quota guard — 1,600 units per upload, 50 per thumbnail
  const thumbPath = metadata.thumbnailPath || jobSpec?.thumbnailUrl;
  const totalUnits = UPLOAD_UNITS + (thumbPath ? THUMB_UNITS : 0);
  if (customerId) await assertYouTubeQuota(customerId, totalUnits);

  let accessToken = tokens.accessToken;

  // Refresh if expired — persist new access token so subsequent uploads succeed
  if (tokens.refreshToken && tokens.tokenExpiry && new Date(tokens.tokenExpiry) < new Date()) {
    try {
      const refreshed = await refreshAccessToken(tokens.refreshToken);
      accessToken = refreshed.access_token;
      if (customerId && brandId) {
        const { saveTokens } = require('../../services/token_store');
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
      }
    } catch (err) {
      const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
      throw new Error(`YouTube OAuth refresh failed (brand ${brandId}): ${detail}`);
    }
  }

  const videoMeta = {
    snippet: {
      title: (metadata.title || jobSpec?.publishCopy?.youtube?.title || jobSpec?.templateName || 'New video').slice(
        0,
        100
      ),
      description: appendSupportPromoToDescription(
        metadata.description || jobSpec?.publishCopy?.youtube?.description || ''
      ).slice(
        0,
        5000
      ),
      tags: (metadata.tags || []).slice(0, 500 / 10), // rough tag budget
      categoryId: metadata.categoryId || '22', // People & Blogs
    },
    status: {
      privacyStatus: metadata.privacyStatus || 'private',
      selfDeclaredMadeForKids: false,
      ...(metadata.publishAt ? { publishAt: metadata.publishAt } : {}),
    },
  };

  // ── Resumable upload initiation ──────────────────────────────────────────
  let initRes;
  try {
    initRes = await axios.post(
      `${YT_UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
      videoMeta,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/*',
        },
      }
    );
  } catch (err) {
    const ytErr = err.response?.data?.error;
    const msg = ytErr
      ? `${ytErr.message || ytErr.reason || 'YouTube upload init failed'} (${ytErr.errors?.[0]?.reason || ytErr.status || err.response?.status})`
      : err.message;
    throw new Error(msg);
  }
  const uploadUrl = initRes.headers.location;
  if (!uploadUrl) throw new Error('YouTube: no resumable upload URL returned');

  // ── Stream video to upload URL ───────────────────────────────────────────
  let videoStream;
  let videoSize;

  if (videoPath.startsWith('http')) {
    const dlRes = await axios.get(videoPath, {
      responseType: 'arraybuffer',
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 600000,
    });
    const buf = Buffer.from(dlRes.data);
    videoSize = buf.length;
    if (!videoSize) throw new Error('YouTube: video download returned empty body');
    videoStream = buf;
  } else {
    videoStream = fs.createReadStream(videoPath);
    videoSize = fs.statSync(videoPath).size;
  }

  let uploadRes;
  try {
    uploadRes = await axios.put(uploadUrl, videoStream, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'video/*',
        'Content-Length': videoSize,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000,
    });
  } catch (err) {
    const ytErr = err.response?.data?.error;
    const msg = ytErr
      ? `${ytErr.message || ytErr.reason || 'YouTube upload failed'} (${ytErr.errors?.[0]?.reason || err.response?.status})`
      : err.message;
    throw new Error(msg);
  }

  const videoId = uploadRes.data?.id;
  if (!videoId) throw new Error('YouTube: upload succeeded but no videoId returned');

  // ── Track quota ──────────────────────────────────────────────────────────
  if (customerId) await trackYouTubeQuota(customerId, UPLOAD_UNITS).catch(() => {});

  // ── Set thumbnail if available ───────────────────────────────────────────
  if (thumbPath) {
    try {
      let thumbStream;
      if (thumbPath.startsWith('http')) {
        const tRes = await axios.get(thumbPath, { responseType: 'stream' });
        thumbStream = tRes.data;
      } else {
        thumbStream = fs.createReadStream(thumbPath);
      }
      await axios.post(`${YT_API_BASE}/thumbnails/set?videoId=${videoId}`, thumbStream, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg' },
      });
      if (customerId) await trackYouTubeQuota(customerId, THUMB_UNITS).catch(() => {});
    } catch (_e) {
      // Non-fatal — video uploaded, thumbnail optional
    }
  }

  return {
    platformJobId: videoId,
    url: `https://youtu.be/${videoId}`,
    status: metadata.privacyStatus === 'private' ? 'private' : 'published',
  };
}

/**
 * Build the OAuth authorization URL for YouTube.
 * Redirect user to this URL to start the OAuth flow.
 */
function buildAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope:
      'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline',
    prompt: 'select_account consent',
    state: state || '',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
async function exchangeCode(code, redirectUri) {
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    code,
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  return res.data; // { access_token, refresh_token, expires_in, scope }
}

/** Prefer @handle from customUrl; fall back to channel title. */
function channelDisplayHandle(snippet) {
  const custom = snippet?.customUrl || '';
  if (custom) {
    const at = custom.match(/@([\w.-]+)/i);
    if (at) return `@${at[1]}`;
    return custom.replace(/^https?:\/\/(www\.)?youtube\.com\//i, '').replace(/^@/, '@');
  }
  const title = snippet?.title;
  return title ? String(title) : null;
}

function normalizeHandle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?youtube\.com\//i, '')
    .replace(/^@/, '')
    .trim();
}

/**
 * Pick the channel row that belongs to a brand (auraflux-{brand} pattern).
 */
function matchChannelForBrand(channels, { brandName, expectedHandle, channelId } = {}) {
  if (channelId) {
    const byId = channels.find((c) => c.platformUserId === channelId);
    if (byId) return byId;
  }

  const want = normalizeHandle(expectedHandle);
  const brandKey = normalizeHandle(brandName);

  if (want) {
    const exact = channels.find((c) => normalizeHandle(c.platformHandle) === want);
    if (exact) return exact;
    const partial = channels.find((c) => normalizeHandle(c.platformHandle).includes(want));
    if (partial) return partial;
  }

  if (brandKey) {
    const aura = `auraflux-${brandKey}`;
    const byAura = channels.find((c) => normalizeHandle(c.platformHandle).includes(aura));
    if (byAura) return byAura;
    const byBrand = channels.find((c) => normalizeHandle(c.platformHandle).includes(brandKey));
    if (byBrand) return byBrand;
  }

  return channels.length === 1 ? channels[0] : null;
}

/**
 * Get the authenticated user's YouTube channel info.
 */
async function getChannelInfo(accessToken) {
  const res = await axios.get(`${YT_API_BASE}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ch = res.data?.items?.[0];
  return ch
    ? { platformUserId: ch.id, platformHandle: channelDisplayHandle(ch.snippet) || ch.snippet?.title }
    : null;
}

/**
 * List ALL YouTube channels accessible on the authenticated Google account.
 * Used for bulk-connect to map multiple brand channels in one OAuth session (CPD-866).
 * Returns up to 50 channels — sufficient for any realistic operator roster.
 */
async function listAllChannels(accessToken) {
  const res = await axios.get(
    `${YT_API_BASE}/channels?part=snippet&mine=true&maxResults=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return (res.data?.items || []).map((ch) => ({
    platformUserId: ch.id,
    platformHandle: channelDisplayHandle(ch.snippet) || ch.snippet?.title || null,
    thumbnailUrl: ch.snippet?.thumbnails?.default?.url || null,
  }));
}

/** List uploads on a specific channel (not just mine=true default). */
async function listChannelUploads(accessToken, channelId) {
  const chRes = await axios.get(`${YT_API_BASE}/channels`, {
    params: { part: 'contentDetails', id: channelId },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const playlistId = chRes.data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) return [];

  const items = [];
  let pageToken;
  do {
    const res = await axios.get(`${YT_API_BASE}/playlistItems`, {
      params: {
        part: 'snippet',
        playlistId,
        maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items.map((it) => ({
    videoId: it.snippet?.resourceId?.videoId,
    title: it.snippet?.title || '',
    publishedAt: it.snippet?.publishedAt || null,
  }));
}

async function deleteVideo(accessToken, videoId) {
  await axios.delete(`${YT_API_BASE}/videos`, {
    params: { id: videoId },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function ensureAccessToken(tokens, customerId, brandId) {
  let accessToken = tokens.accessToken;
  if (tokens.refreshToken && tokens.tokenExpiry && new Date(tokens.tokenExpiry) < new Date()) {
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    accessToken = refreshed.access_token;
    if (customerId && brandId) {
      const { saveTokens } = require('../../services/token_store');
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
    }
  }
  return accessToken;
}

module.exports = {
  publish,
  buildAuthUrl,
  exchangeCode,
  getChannelInfo,
  listAllChannels,
  listChannelUploads,
  deleteVideo,
  ensureAccessToken,
  refreshAccessToken,
  matchChannelForBrand,
  channelDisplayHandle,
};
